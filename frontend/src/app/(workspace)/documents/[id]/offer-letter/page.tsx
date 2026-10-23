"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import OfferLetterModal from "@/components/OfferLetterModal";
import { apiRequest } from "@/lib/apiClient";

export default function OfferLetterPage() {
    const params = useParams();
    const router = useRouter();
    const resumeId = params?.id as string;
    const [resumeFilename, setResumeFilename] = useState<string | undefined>();

    useEffect(() => {
        if (!resumeId) return;
        apiRequest(`/docs/documents/${resumeId}`)
            .then((data) => setResumeFilename(data?.data?.document?.originalFilename))
            .catch(() => setResumeFilename(undefined));
    }, [resumeId]);

    if (!resumeId) {
        return (
            <div className="p-8 text-sm text-foreground-secondary">
                Missing document.{" "}
                <Link href="/documents" className="text-accent hover:underline">
                    Back to library
                </Link>
            </div>
        );
    }

    const backHref = `/documents/details?doc=${encodeURIComponent(resumeId)}`;

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-4">
            <Link
                href={backHref}
                className="inline-flex items-center gap-2 text-sm text-foreground-secondary hover:text-accent"
            >
                <ArrowLeft size={14} />
                Back to resume
            </Link>
            <div className="space-y-1">
                <h1 className="text-xl font-bold text-foreground">Create offer letter PDF</h1>
                <p className="text-sm text-foreground-secondary">
                    Fill the form and click Generate &amp; save — you will open the PDF page to print or download.
                </p>
            </div>
            <OfferLetterModal
                open
                presentation="page"
                documentId={resumeId}
                resumeFilename={resumeFilename}
                onClose={() => router.push(backHref)}
                onCreated={(newId) => router.push(`/documents/${encodeURIComponent(newId)}`)}
            />
        </div>
    );
}
