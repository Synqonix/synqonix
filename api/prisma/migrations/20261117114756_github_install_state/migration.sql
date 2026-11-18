-- CreateTable
CREATE TABLE "GithubInstallState" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubInstallState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GithubInstallState_stateHash_key" ON "GithubInstallState"("stateHash");

-- CreateIndex
CREATE INDEX "GithubInstallState_expiresAt_idx" ON "GithubInstallState"("expiresAt");
