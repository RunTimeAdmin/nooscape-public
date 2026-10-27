/**
 * A request the operator made that a rule of the product refuses: the four-eyes rule on a publisher key, a domain the agent has not
 * asserted, a challenge that is no longer pending, a record that is not there. It is not a fault of the database, and its message is
 * written for the operator, so the operator procedures say it as it is and not as "Live data is temporarily unavailable." (liveData.ts,
 * `databaseFailure`). Anything else thrown on the way is still a fault: it is logged and the client is told the fixed summary.
 */
export class OperatorRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorRuleError";
  }
}
