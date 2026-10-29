/** An expected failure with a message fit to show the user as-is (no stack trace). */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
