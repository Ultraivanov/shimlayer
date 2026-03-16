from enum import Enum


class TaskType(str, Enum):
    STUCK_RECOVERY = "stuck_recovery"
    QUICK_JUDGMENT = "quick_judgment"


class TaskStatus(str, Enum):
    QUEUED = "queued"
    CLAIMED = "claimed"
    COMPLETED = "completed"
    FAILED = "failed"
    DISPUTED = "disputed"
    REFUNDED = "refunded"


class ArtifactType(str, Enum):
    SCREENSHOT = "screenshot"
    LOGS = "logs"
    JSON_PAYLOAD = "json_payload"


class ReviewStatus(str, Enum):
    AUTO_PASSED = "auto_passed"
    MANUAL_REQUIRED = "manual_required"
    APPROVED = "approved"
    REJECTED = "rejected"
