import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as v1_router
from app.middleware import RequestContextMiddleware
from app.config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger = logging.getLogger("shimlayer.api")
    logger.info(
        "startup_config repository=%s cors_origins=%s",
        settings.shimlayer_repository,
        settings.shimlayer_cors_origins,
    )
    for warning in settings.security_warnings:
        logger.warning("startup_security_warning: %s", warning)
    yield


app = FastAPI(
    title="ShimLayer API",
    version="0.1.0",
    description="HITL layer for last-mile failures in agentic AI workflows.",
    lifespan=lifespan,
)

cors_origins = [origin.strip() for origin in settings.shimlayer_cors_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestContextMiddleware)
app.include_router(v1_router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger = logging.getLogger("shimlayer.api")
    request_id = getattr(request.state, "request_id", None)
    logger.exception("unhandled_exception", extra={"request_id": request_id, "path": request.url.path})
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": request_id},
    )
