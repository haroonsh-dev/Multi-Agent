"""
Visibility Docs AI - Setup Script
Run this script to set up the project.
"""

import os
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def run(cmd, cwd=None):
    print(f"Running: {cmd}")
    result = subprocess.run(cmd, shell=True, cwd=cwd or BASE_DIR)
    if result.returncode != 0:
        print(f"Warning: Command exited with code {result.returncode}")
    return result


def main():
    print("=" * 60)
    print("Visibility Docs AI - Setup")
    print("=" * 60)

    # Step 1: Install Python dependencies
    print("\n[1/4] Installing Python dependencies...")
    run(f"{sys.executable} -m pip install -r backend/requirements.txt")

    # Step 2: Setup .env file
    print("\n[2/4] Setting up environment...")
    env_path = os.path.join(BASE_DIR, "backend", ".env")
    if not os.path.exists(env_path):
        try:
            import shutil
            shutil.copy(
                os.path.join(BASE_DIR, "backend", ".env.example"),
                env_path,
            )
            print(f"Created {env_path} from .env.example")
            print(">>> Please edit backend/.env and add your API keys! <<<")
        except Exception:
            print("Could not create .env file automatically.")

    # Step 3: Validate PaddleOCR install
    print("\n[3/4] Checking PaddleOCR...")
    try:
        from paddleocr import PaddleOCR
        print("PaddleOCR is installed.")
    except ImportError:
        print("Installing PaddleOCR...")
        run(f"{sys.executable} -m pip install paddlepaddle paddleocr")

    # Step 4: Test import
    print("\n[4/4] Testing imports...")
    try:
        subprocess.run(
            f"cd backend && {sys.executable} -c \"from app.main import app; print('OK - All imports successful!')\"",
            shell=True,
            check=True,
        )
    except subprocess.CalledProcessError:
        print("Import test failed. Check the error messages above.")

    print("\n" + "=" * 60)
    print("Setup complete!")
    print("\nNext steps:")
    print("1. Edit backend/.env and add your GROQ_API_KEY and Supabase credentials")
    print("2. Run the SQL schema in supabase_schema.sql in your Supabase SQL editor")
    print("3. Start the backend: cd backend && python run.py")
    print("4. Start the frontend: cd frontend && npm install && npm run dev")
    print("=" * 60)


if __name__ == "__main__":
    main()
