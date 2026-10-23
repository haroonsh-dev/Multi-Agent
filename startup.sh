#!/bin/bash
set -e

cd /app/backend
echo "[startup] Starting backend on port 8000..."
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --log-level info &
BACKEND_PID=$!

cd /app/frontend
# Use PORT from env (HF Spaces = 7860) or default to 3000
FRONTEND_PORT=${PORT:-3000}
echo "[startup] Starting frontend on port $FRONTEND_PORT..."
PORT=$FRONTEND_PORT node server.js &
FRONTEND_PID=$!

cd /app/backend

sleep 4
echo "[startup] Backend PID $BACKEND_PID | Frontend PID $FRONTEND_PID"
echo "[startup] Frontend: http://0.0.0.0:$FRONTEND_PORT → API → Backend :8000"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" SIGTERM SIGINT
wait
