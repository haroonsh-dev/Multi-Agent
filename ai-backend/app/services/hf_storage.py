import os
import io
import logging
from pathlib import Path
from ..config import settings

logger = logging.getLogger("visibility-docs")


class HFStorage:
    def __init__(self):
        self._repo_id = None
        self._api = None
        self._available = False

    def _init(self):
        if self._available:
            return
        token = os.getenv("HF_TOKEN") or settings.HF_TOKEN or ""
        repo = os.getenv("HF_DATASET_REPO") or settings.HF_DATASET_REPO or ""
        if token and repo:
            try:
                from huggingface_hub import HfApi
                self._api = HfApi(token=token)
                try:
                    self._api.repo_info(repo_id=repo, repo_type="dataset")
                except Exception:
                    self._api.create_repo(repo_id=repo, repo_type="dataset", private=True, exist_ok=True)
                self._repo_id = repo
                self._available = True
                logger.info(f"HF storage initialized: {repo}")
            except Exception as e:
                logger.warning(f"HF storage init failed: {e}")

    @property
    def available(self):
        return self._available

    def upload(self, file_path: str, remote_path: str = None) -> str:
        self._init()
        if not self._available:
            return file_path
        try:
            if remote_path is None:
                remote_path = os.path.basename(file_path)
            self._api.upload_file(
                path_or_fileobj=file_path,
                path_in_repo=remote_path,
                repo_id=self._repo_id,
                repo_type="dataset",
            )
            url = f"https://huggingface.co/datasets/{self._repo_id}/resolve/main/{remote_path}"
            logger.info(f"Uploaded to HF: {url}")
            return url
        except Exception as e:
            logger.error(f"HF upload failed: {e}")
            return file_path

    def upload_bytes(self, data: bytes, remote_path: str) -> str:
        self._init()
        if not self._available:
            return ""
        try:
            self._api.upload_file(
                path_or_fileobj=io.BytesIO(data),
                path_in_repo=remote_path,
                repo_id=self._repo_id,
                repo_type="dataset",
            )
            url = f"https://huggingface.co/datasets/{self._repo_id}/resolve/main/{remote_path}"
            logger.info(f"Uploaded bytes to HF: {url}")
            return url
        except Exception as e:
            logger.error(f"HF upload_bytes failed: {e}")
            return ""

hf_storage = HFStorage()
