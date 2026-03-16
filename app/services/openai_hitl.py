from app.models import OpenAIInterruptionIngestRequest


def compose_context_capsule(payload: OpenAIInterruptionIngestRequest) -> dict:
    tool_name = payload.tool_name.lower()
    question = "Should this tool call be approved?"
    options = ["approve", "reject"]
    task_type = "quick_judgment"
    constraints = [
        "Follow tenant policy and playbook.",
        "Reject if arguments look unsafe or unrelated to user intent.",
    ]
    if "refund" in tool_name:
        question = "Approve refund action?"
    elif "email" in tool_name:
        question = "Approve outbound email send?"
    elif "delete" in tool_name or "cancel" in tool_name:
        question = "Approve destructive action?"
    elif "selector" in tool_name or "click" in tool_name:
        question = "Which selector/action should be used to continue safely?"
        options = ["primary_candidate", "secondary_candidate", "reject"]
        task_type = "stuck_recovery"

    return {
        "task_type_hint": task_type,
        "summary": f"Interruption for tool '{payload.tool_name}' in run {payload.run_id}.",
        "question": question,
        "options": options,
        "constraints": constraints,
        "tool_arguments": payload.tool_arguments,
        "metadata": payload.metadata,
    }
