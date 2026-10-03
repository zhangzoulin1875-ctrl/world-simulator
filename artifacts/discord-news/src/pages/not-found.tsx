import React from "react";
import { Link } from "wouter";
import { FileQuestion, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] py-24 px-4 text-center animate-in fade-in">
      <div className="w-16 h-16 bg-secondary rounded-2xl flex items-center justify-center mb-6">
        <FileQuestion className="w-8 h-8 text-muted-foreground" />
      </div>
      <h1 className="text-4xl md:text-5xl font-serif font-bold text-foreground mb-4">404</h1>
      <p className="text-xl text-muted-foreground mb-8 max-w-md">
        The page you're looking for doesn't exist or has been moved.
      </p>
      <Button asChild size="lg" className="shadow-sm">
        <Link href="/">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Return to Dashboard
        </Link>
      </Button>
    </div>
  );
}
