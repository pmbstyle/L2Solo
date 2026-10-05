// The deadlines of the board's records in one min-heap (design 16.17): push
// and pop are O(log n), the next deadline is O(1). A record that closed or got
// a new deadline is not removed; the caller skips an entry whose deadline no
// longer matches the record (lazy deletion).
class BoardExpiryQueue {
    constructor() {
        this.deadlines = [];
        this.ids = [];
    }

    get size() {
        return this.ids.length;
    }

    clear() {
        this.deadlines.length = 0;
        this.ids.length = 0;
    }

    push(deadline, id) {
        this.deadlines.push(Number(deadline));
        this.ids.push(Number(id));
        let child = this.ids.length - 1;
        while (child > 0) {
            const parent = (child - 1) >> 1;
            if (this.deadlines[parent] <= this.deadlines[child]) break;
            this.swap(parent, child);
            child = parent;
        }
    }

    peekDeadline() {
        return this.ids.length ? this.deadlines[0] : Infinity;
    }

    pop() {
        if (!this.ids.length) return null;
        const top = { deadline: this.deadlines[0], id: this.ids[0] };
        const last = this.ids.length - 1;
        this.swap(0, last);
        this.deadlines.pop();
        this.ids.pop();
        let parent = 0;
        for (;;) {
            const left = parent * 2 + 1;
            const right = left + 1;
            let smallest = parent;
            if (left < this.ids.length && this.deadlines[left] < this.deadlines[smallest]) smallest = left;
            if (right < this.ids.length && this.deadlines[right] < this.deadlines[smallest]) smallest = right;
            if (smallest === parent) break;
            this.swap(parent, smallest);
            parent = smallest;
        }
        return top;
    }

    swap(left, right) {
        const deadline = this.deadlines[left];
        this.deadlines[left] = this.deadlines[right];
        this.deadlines[right] = deadline;
        const id = this.ids[left];
        this.ids[left] = this.ids[right];
        this.ids[right] = id;
    }
}

module.exports = BoardExpiryQueue;
