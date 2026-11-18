-- AlterTable
ALTER TABLE "ApiToken" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY['read', 'write']::TEXT[],
ADD COLUMN     "workspaceId" TEXT;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

