import logging
import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from ..models.schemas import SignupRequest, LoginRequest, AuthResponse, UserMe
from ..auth_deps import get_current_user
from ..database import create_user, get_user_by_email, get_user_by_id
from ..auth.service import hash_password, verify_password, create_access_token, generate_org_id

logger = logging.getLogger("visibility-docs")

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/signup", response_model=AuthResponse)
async def signup(body: SignupRequest):
    email = body.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    existing = get_user_by_email(email)
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    user_id = uuid.uuid4().hex
    org_id = generate_org_id()
    hashed = hash_password(body.password)
    create_user(user_id, email, hashed, org_id)
    token = create_access_token(user_id, email, org_id)
    return AuthResponse(token=token, user_id=user_id, email=email, organization_id=org_id)


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginRequest):
    email = body.email.strip().lower()
    user = get_user_by_email(email)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not verify_password(body.password, user["hashed_password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_access_token(user["id"], user["email"], user["organization_id"])
    return AuthResponse(token=token, user_id=user["id"], email=user["email"], organization_id=user["organization_id"])


@router.get("/me", response_model=UserMe)
async def get_me(current_user: dict = Depends(get_current_user)):
    return UserMe(
        user_id=current_user["user_id"],
        email=current_user["email"],
        organization_id=current_user["org_id"],
    )
