# Clan crest inference models

Tessera by Jagrat Patel (TheJagStudio), [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). The Tessera graph, palette and adapted sampler use the same license. The CLIP graph is based on [OpenAI CLIP](https://huggingface.co/openai/clip-vit-base-patch32) (MIT).

The [versioned bundle](https://l2solo.com/models/tessera-small-onnx-v1.zip) contains standalone ONNX graphs with their weights, the CLIP tokenizer, the Tessera palette and attribution. `ModelFiles.js` pins the archive and its manifest. Rebuilding the bundle requires updating both hashes and publishing under a new versioned filename.

`scripts/export-tessera-onnx.py` exports the graphs using PyTorch 2.12.1, Transformers 4.57.6, ONNX 1.20.1 and the [Tessera source at revision 8de9337](https://huggingface.co/spaces/thejagstudio/tessera-pixel-studio/tree/8de933771e65ab3931b456090d065a1044c9ff18). The Node inference process runs these graphs on CPU.

On Windows, ONNX Runtime needs the [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) for the Node runtime's architecture. The server checks that it can load ONNX Runtime before downloading the bundle.
