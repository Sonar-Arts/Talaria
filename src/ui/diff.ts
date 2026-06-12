export interface NaiveDiff {
	/** Lines present only in the old text (the changed middle). */
	removed: string[];
	/** Lines present only in the new text (the changed middle). */
	added: string[];
	/** Identical lines at the start of both texts. */
	unchangedHead: number;
	/** Identical lines at the end of both texts. */
	unchangedTail: number;
}

/**
 * Cheap line diff: trim the common prefix and suffix and report the changed
 * middles wholesale. For full rewrites it degenerates to "everything changed",
 * which is honest — the card's full-content view stays the ground truth.
 */
export function naiveLineDiff(oldText: string, newText: string): NaiveDiff {
	const a = oldText.split("\n");
	const b = newText.split("\n");

	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;

	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail++;
	}

	return {
		removed: a.slice(head, a.length - tail),
		added: b.slice(head, b.length - tail),
		unchangedHead: head,
		unchangedTail: tail,
	};
}
