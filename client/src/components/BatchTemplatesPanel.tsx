import React, { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Play, Clock, Tag } from "lucide-react";
import {
  BATCH_TEMPLATES,
  filterTemplatesByPeriod,
  isBatchTemplateRunnable,
  searchTemplates,
  BatchTemplate,
} from "@/lib/batch-templates";

interface BatchTemplatesPanelProps {
  onSelectTemplate?: (template: BatchTemplate) => void;
  onStartTemplate?: (templateId: string) => Promise<void>;
  isLoading?: boolean;
}

export const BatchTemplatesPanel: React.FC<BatchTemplatesPanelProps> = ({
  onSelectTemplate,
  onStartTemplate,
  isLoading = false,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFilter, setSelectedFilter] = useState<
    "all" | "daily" | "weekly" | "monthly"
  >("all");
  const [startingTemplate, setStartingTemplate] = useState<string | null>(null);

  const searchedTemplates = searchQuery
    ? searchTemplates(searchQuery)
    : BATCH_TEMPLATES;
  const filteredTemplates = filterTemplatesByPeriod(
    searchedTemplates,
    selectedFilter
  );

  const handleStartTemplate = async (template: BatchTemplate) => {
    try {
      setStartingTemplate(template.id);
      if (onSelectTemplate) {
        onSelectTemplate(template);
      }
      if (onStartTemplate) {
        await onStartTemplate(template.id);
      }
    } catch (error) {
      console.error("Failed to start template:", error);
    } finally {
      setStartingTemplate(null);
    }
  };

  const operationTypeColors: Record<string, string> = {
    reanalyze: "bg-blue-100 text-blue-800",
    reschedule: "bg-green-100 text-green-800",
    conflict_resolution: "bg-red-100 text-red-800",
    optimization: "bg-purple-100 text-purple-800",
  };

  return (
    <div className="space-y-4">
      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search templates..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2">
        {(["all", "daily", "weekly", "monthly"] as const).map(filter => (
          <Button
            key={filter}
            variant={selectedFilter === filter ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedFilter(filter)}
            className="capitalize"
          >
            {filter}
          </Button>
        ))}
      </div>

      {/* Templates Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredTemplates.map(template => {
          const runnable = isBatchTemplateRunnable(template);
          return (
            <Card
              key={template.id}
              className="hover:shadow-md transition-shadow"
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      {template.icon && (
                        <span className="text-lg">{template.icon}</span>
                      )}
                      <CardTitle className="text-base">
                        {template.name}
                      </CardTitle>
                    </div>
                    <CardDescription className="text-xs">
                      {template.description}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                {/* Operation Type Badge */}
                <div className="flex gap-2 flex-wrap">
                  <Badge
                    className={operationTypeColors[template.operationType]}
                  >
                    {template.operationType.replace(/_/g, " ")}
                  </Badge>
                  {!runnable && <Badge variant="outline">Not available</Badge>}
                </div>

                {/* Metadata */}
                <div className="space-y-2 text-xs text-muted-foreground">
                  {template.estimatedDuration && (
                    <div className="flex items-center gap-2">
                      <Clock className="h-3 w-3" />
                      <span>Est. {template.estimatedDuration} min</span>
                    </div>
                  )}

                  {template.tags && template.tags.length > 0 && (
                    <div className="flex items-start gap-2">
                      <Tag className="h-3 w-3 mt-0.5 flex-shrink-0" />
                      <div className="flex flex-wrap gap-1">
                        {template.tags.map(tag => (
                          <Badge
                            key={tag}
                            variant="secondary"
                            className="text-xs"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Config Summary */}
                {template.config.options && (
                  <div className="text-xs bg-muted/50 p-2 rounded space-y-1">
                    <p className="font-medium">Config:</p>
                    {template.config.options.parallelLimit && (
                      <p>• Parallel: {template.config.options.parallelLimit}</p>
                    )}
                    {template.config.options.retryOnFailure && (
                      <p>• Retry: {template.config.options.maxRetries || 2}x</p>
                    )}
                  </div>
                )}

                {/* Action Button */}
                <Button
                  className="w-full"
                  size="sm"
                  onClick={() => handleStartTemplate(template)}
                  disabled={
                    !runnable ||
                    !onStartTemplate ||
                    isLoading ||
                    startingTemplate === template.id
                  }
                >
                  {!runnable ? (
                    "Not available"
                  ) : startingTemplate === template.id ? (
                    <>
                      <span className="animate-spin mr-2">⚙️</span>
                      Starting...
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3 mr-2" />
                      Start Template
                    </>
                  )}
                </Button>
                {!runnable && (
                  <p className="text-xs text-muted-foreground">
                    This operation has no approved server implementation yet.
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Empty State */}
      {filteredTemplates.length === 0 && (
        <Card className="text-center py-8">
          <p className="text-muted-foreground">
            No templates found matching your search
          </p>
        </Card>
      )}

      {/* Info */}
      <Card className="bg-muted/50 border-0">
        <CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">
            💡 <strong>Tip:</strong> Templates provide pre-configured batch
            operation settings optimized for common scheduling tasks. Customize
            settings before running for your specific needs.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default BatchTemplatesPanel;
