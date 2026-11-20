-- AlterEnum
-- A batch records the format of the file it came from. JSON arrays and
-- tab-separated files are read now and are their own formats.
ALTER TYPE "ImportFormat" ADD VALUE 'JSON';
ALTER TYPE "ImportFormat" ADD VALUE 'TSV';
