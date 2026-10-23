import os
from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

load_dotenv()

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Well-known dev-only value. Allowed in development; rejected in production so a
# deployment can never ship trusting a public default.
DEV_INTERNAL_SERVICE_KEY = "dev-internal-service-key"


class Settings(BaseSettings):
    SUPABASE_URL: str = ""
    SUPABASE_KEY: str = ""
    SUPABASE_JWT_SECRET: str = ""
    DATABASE_URL: str = ""

    GROQ_API_KEY: str = ""

    USE_GPU: bool = False
    PINECONE_API_KEY: str = ""
    PINECONE_INDEX_NAME: str = ""

    HF_TOKEN: str = ""
    HF_DATASET_REPO: str = ""

    EMAIL_HOST: str = "smtp.gmail.com"
    EMAIL_PORT: int = 587
    EMAIL_USERNAME: str = ""
    EMAIL_PASSWORD: str = ""
    EMAIL_FROM: str = ""

    # No hardcoded defaults for secrets: an empty value fails fast in production
    # (see _apply_environment_safety below) instead of silently trusting a
    # publicly-known key.
    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440

    # "development" | "production" — controls fail-fast secret validation.
    ENVIRONMENT: str = "development"

    # Shared secret between the api-gateway and this service. The gateway
    # attaches it as `X-Internal-Service-Key` on every request so mutation
    # endpoints know the call is from the trusted edge (which already enforced
    # RBAC). Direct callers without this key fall back to a user JWT.
    # MUST be overridden in production via INTERNAL_SERVICE_KEY env.
    INTERNAL_SERVICE_KEY: str = ""

    UPLOAD_DIR: str = ""
    PROCESSED_DIR: str = ""
    SHARED_STORAGE_PATH: str = ""
    USE_CLOUD_FILE_STORAGE: bool = False
    MAX_UPLOAD_SIZE_MB: int = 50

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


def _apply_environment_safety(cfg: Settings) -> None:
    """Fail closed in production; keep local dev bootable without a secret file.

    - production: refuse to start if SECRET_KEY / INTERNAL_SERVICE_KEY are
      missing or still the well-known dev value.
    - development: fall back to dev-only values so `python run.py` and the test
      suite boot with zero configuration.
    """
    is_prod = cfg.ENVIRONMENT.lower() in ("production", "prod")
    if is_prod:
        missing = [
            name
            for name, value in {
                "SECRET_KEY": cfg.SECRET_KEY,
                "INTERNAL_SERVICE_KEY": cfg.INTERNAL_SERVICE_KEY,
            }.items()
            if not value or (name == "INTERNAL_SERVICE_KEY" and value == DEV_INTERNAL_SERVICE_KEY)
        ]
        if missing:
            raise RuntimeError(
                "Refusing to start in production with missing/default secrets: "
                + ", ".join(missing)
                + ". Set them via environment variables or ai-backend/.env (ENVIRONMENT=production)."
            )
        return
    if not cfg.SECRET_KEY:
        cfg.SECRET_KEY = "dev-only-secret-key-change-me"
    if not cfg.INTERNAL_SERVICE_KEY:
        cfg.INTERNAL_SERVICE_KEY = DEV_INTERNAL_SERVICE_KEY


settings = Settings()
_apply_environment_safety(settings)
settings.UPLOAD_DIR = os.path.join(_BASE, "uploads")
settings.PROCESSED_DIR = os.path.join(_BASE, "processed")

