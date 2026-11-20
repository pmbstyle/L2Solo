"""Export standalone ONNX graphs from the original Tessera and CLIP weights."""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import onnx
import torch
from onnx import TensorProto, helper, numpy_helper
from torch._subclasses.fake_tensor import FakeTensorMode


def export_graph(model, inputs, archive, weights, names, outputs, destination, dynamic=False):
    axes = {name: {0: "batch"} for name in (*names, *outputs)} if dynamic else None
    with tempfile.TemporaryDirectory() as directory:
        intermediate = Path(directory) / "export.onnx"
        torch.onnx.export(model, inputs, intermediate, input_names=names, output_names=outputs,
                          dynamic_axes=axes, opset_version=17, dynamo=False, do_constant_folding=False)
        graph = onnx.load(intermediate)

    # Preserve the original tensor bytes, including Tessera's half precision.
    casts = []
    with archive.open("rb") as source:
        for tensor in graph.graph.initializer:
            original = weights.get(tensor.name.removeprefix("model."))
            if original is None:
                if len(tensor.raw_data) > 65536:
                    raise ValueError(f"Unmapped model tensor: {tensor.name}")
                continue
            offset = original.untyped_storage()._checkpoint_offset + original.storage_offset() * original.element_size()
            length = original.numel() * original.element_size()
            dtype = {torch.float16: np.float16, torch.float32: np.float32}[original.dtype]
            source.seek(offset)
            raw = source.read(length)
            values = np.frombuffer(raw, dtype=dtype)
            if not original.is_contiguous() or not np.array_equal(values, numpy_helper.to_array(tensor).ravel()):
                raise ValueError(f"Invalid source bytes for {tensor.name}")
            if original.dtype == torch.float16:
                name = tensor.name
                tensor.name = f"{name}.fp16"
                tensor.data_type = TensorProto.FLOAT16
                casts.append(helper.make_node("Cast", [tensor.name], [name], to=TensorProto.FLOAT))
            tensor.raw_data = raw
            tensor.data_location = TensorProto.DEFAULT
    nodes = list(graph.graph.node)
    graph.graph.ClearField("node")
    graph.graph.node.extend(casts + nodes)
    onnx.save_model(graph, destination)


def export_tessera(archive, output):
    from tessera.pipeline import load_model_from_checkpoint

    with FakeTensorMode():
        weights = torch.load(archive, map_location="cpu", weights_only=True)["ema"]
    model, palette, _ = load_model_from_checkpoint(archive, "cpu")
    config = model.cfg
    inputs = (
        torch.full((2, 256), config.mask_id, dtype=torch.int64),
        torch.zeros((2, 24, 512)), torch.zeros((2, 512)), torch.ones((2,)),
        torch.zeros((2, 256, config.vocab_size)), torch.tensor([False, True]),
    )
    export_graph(model, inputs, archive, weights, ["pixels", "text", "pooled", "ratio", "previous", "unconditional"],
                 ["logits"], output / "tessera.onnx", dynamic=True)
    colors = ",\n".join(f"    {json.dumps(color)}" for color in palette.colors.tolist())
    (output / "palette.json").write_text(f"[\n{colors}\n]\n", encoding="utf8")


def export_clip(directory, output):
    from transformers import CLIPTextModel

    class TextEncoder(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model = CLIPTextModel.from_pretrained(directory, attn_implementation="eager").eval()

        def forward(self, ids):
            states, pooled, *_ = self.model(input_ids=ids, return_dict=False)
            return states, pooled

    archive = directory / "pytorch_model.bin"
    with FakeTensorMode():
        weights = torch.load(archive, map_location="cpu", weights_only=True)
    ids = torch.tensor([[49406, 885] + [49407] * 22], dtype=torch.int64)
    export_graph(TextEncoder(), (ids,), archive, weights, ["ids"], ["text", "pooled"], output / "clip.onnx")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tessera-source", required=True, help="Directory containing the author's tessera module")
    parser.add_argument("--tessera-weights", required=True, type=Path)
    parser.add_argument("--clip-directory", required=True, type=Path, help="Pinned CLIP snapshot with config.json and weights")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    sys.path.insert(0, args.tessera_source)
    os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
    args.output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(2)
    with torch.inference_mode():
        export_tessera(args.tessera_weights, args.output)
        export_clip(args.clip_directory, args.output)


if __name__ == "__main__":
    main()
