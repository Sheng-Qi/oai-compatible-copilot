export class OutputTextStreamNormalizer {
	private _emittedText = "";
	private _replayBuffer = "";
	private _replayCursor: number | null = null;

	normalize(streamedText: string): string {
		if (this._replayCursor !== null) {
			const expected = this._emittedText.slice(this._replayCursor, this._replayCursor + streamedText.length);
			if (streamedText === expected) {
				this._replayBuffer += streamedText;
				this._replayCursor += streamedText.length;
				if (this._replayCursor === this._emittedText.length) {
					this._replayBuffer = "";
					this._replayCursor = null;
				}
				return "";
			}

			const bufferedText = this._replayBuffer + streamedText;
			this._replayBuffer = "";
			this._replayCursor = null;
			this._emittedText += bufferedText;
			return bufferedText;
		}

		if (this._emittedText.length > 1 && this._emittedText.startsWith(streamedText)) {
			if (streamedText.length === this._emittedText.length) {
				return "";
			}
			this._replayBuffer = streamedText;
			this._replayCursor = streamedText.length;
			return "";
		}

		this._emittedText += streamedText;
		return streamedText;
	}

	flushPending(): string {
		const bufferedText = this._replayBuffer;
		if (bufferedText) {
			this._emittedText += bufferedText;
		}
		this._replayBuffer = "";
		this._replayCursor = null;
		return bufferedText;
	}
}
