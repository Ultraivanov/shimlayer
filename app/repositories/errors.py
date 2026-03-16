class InsufficientFlowCreditsError(Exception):
    pass


class UnknownPackageError(Exception):
    pass


class RefundNotAllowedError(Exception):
    pass


class RateLimitExceededError(Exception):
    pass
