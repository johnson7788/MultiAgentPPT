"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { usePresentationState } from "@/states/presentation-state";
import { SlideParser } from "../utils/parser";
import { updatePresentation } from "@/app/_actions/presentation/presentationActions";
import { useCompletion } from "ai/react";

export function PresentationGenerationManager() {
  const {
    numSlides,
    language,
    presentationInput,
    shouldStartOutlineGeneration,
    shouldStartPresentationGeneration,
    setIsGeneratingOutline,
    setShouldStartOutlineGeneration,
    setShouldStartPresentationGeneration,
    resetGeneration,
    setOutline,
    setSlides,
    setIsGeneratingPresentation,
    setDetailLogs, // 新增解构
  } = usePresentationState();

  // Create a ref for the streaming parser to persist between renders
  const streamingParserRef = useRef<SlideParser>(new SlideParser());

  // Add refs to track the animation frame IDs
  const slidesRafIdRef = useRef<number | null>(null);
  const outlineRafIdRef = useRef<number | null>(null);

  // Create buffer refs to store the latest content
  // Note: The types should match what setOutline and setSlides expect
  const slidesBufferRef = useRef<ReturnType<
    SlideParser["getAllSlides"]
  > | null>(null);
  const outlineBufferRef = useRef<string[] | null>(null);

  // Function to update slides using requestAnimationFrame
  const updateSlidesWithRAF = (): void => {
    // Always check for the latest slides in the buffer
    console.log("RAF executed: updating slides", slidesBufferRef.current);
    if (slidesBufferRef.current !== null) {
      setSlides(slidesBufferRef.current);
      slidesBufferRef.current = null;
    }

    // Clear the current frame ID
    slidesRafIdRef.current = null;

    // We don't recursively schedule new frames
    // New frames will be scheduled only when new content arrives
  };

  // Function to update outline using requestAnimationFrame
  const updateOutlineWithRAF = (): void => {
    // Always check for the latest outline in the buffer
    if (outlineBufferRef.current !== null) {
      setOutline(outlineBufferRef.current);
      outlineBufferRef.current = null;
    }

    // Clear the current frame ID
    outlineRafIdRef.current = null;

    // We don't recursively schedule new frames
    // New frames will be scheduled only when new content arrives
  };

  // Outline generation
  const { completion: outlineCompletion, complete: generateOutline } =
    useCompletion({
      api: "/api/presentation/outline",
      body: {
        prompt: presentationInput,
        numberOfCards: numSlides,
        language,
      },
      onFinish: (_prompt, completion) => {
        // First, cancel any pending animation frame to avoid race conditions
        if (outlineRafIdRef.current !== null) {
          cancelAnimationFrame(outlineRafIdRef.current);
          outlineRafIdRef.current = null;
        }

        // Now, perform a final parse and update of the outline from the complete response
        const sections = completion.split(/^# /gm).filter(Boolean);
        const finalOutline: string[] =
          sections.length > 0
            ? sections.map((section) => `# ${section}`.trim())
            : [completion];
        setOutline(finalOutline);

        // Update generation status
        setIsGeneratingOutline(false);
        setShouldStartOutlineGeneration(false);
        setShouldStartPresentationGeneration(false);

        // Get other state values needed for saving
        const { currentPresentationId, currentPresentationTitle, theme, language } =
          usePresentationState.getState();

        // Save the final presentation outline
        if (currentPresentationId) {
          void updatePresentation({
            id: currentPresentationId,
            outline: finalOutline, // Use the final, complete outline
            title: currentPresentationTitle ?? "",
            theme,
            language,
          });
        }
      },
      onError: (error) => {
        toast.error("Failed to generate outline: " + error.message);
        resetGeneration();

        // Cancel any pending outline animation frame
        if (outlineRafIdRef.current !== null) {
          cancelAnimationFrame(outlineRafIdRef.current);
          outlineRafIdRef.current = null;
        }
      },
    });

  useEffect(() => {
    if (outlineCompletion && typeof outlineCompletion === "string") {
      // Parse the outline into sections
      const sections = outlineCompletion.split(/^# /gm).filter(Boolean);
      const outlineItems: string[] =
        sections.length > 0
          ? sections.map((section) => `# ${section}`.trim())
          : [outlineCompletion];

      // Store the latest outline in the buffer
      outlineBufferRef.current = outlineItems;

      // Only schedule a new frame if one isn't already pending
      if (outlineRafIdRef.current === null) {
        outlineRafIdRef.current = requestAnimationFrame(updateOutlineWithRAF);
      }
    }
  }, [outlineCompletion]);

  // Watch for outline generation start
  useEffect(() => {
    const startOutlineGeneration = async (): Promise<void> => {
      const { presentationInput, numSlides, language } =
        usePresentationState.getState();
      if (shouldStartOutlineGeneration) {
        try {
          setIsGeneratingOutline(true);

          // Start the RAF cycle for outline updates
          if (outlineRafIdRef.current === null) {
            outlineRafIdRef.current =
              requestAnimationFrame(updateOutlineWithRAF);
          }

          await generateOutline(presentationInput ?? "", {
            body: {
              prompt: presentationInput ?? "",
              numberOfCards: numSlides,
              language,
            },
          });
        } catch (error) {
          console.log(error);
          // Error is handled by onError callback
        } finally {
          setIsGeneratingOutline(false);
          setShouldStartOutlineGeneration(false);
        }
      }
    };

    void startOutlineGeneration();
  }, [shouldStartOutlineGeneration]);

  // 流式生成演示文稿的函数
  const generatePresentationStream = async ({
    title,
    outline,
    language: targetLanguage,
    tone,
  }: {
    title: string;
    outline: string[];
    language: string;
    tone?: string;
  }) => {
    const parser = streamingParserRef.current;
    parser.reset();
    setDetailLogs([]); // 替换
    try {
      const response = await fetch("/api/presentation/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, outline, language: targetLanguage, tone, numSlides}),
      });
      console.log("[前端] fetch /api/presentation/generate 返回", response);
      if (!response.body) throw new Error("No response body");
  
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bufferedText = "";
      let done = false;
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        console.log(`[前端] 读取到chunk, 长度:`, bufferedText?.length, "done:", done);
        done = streamDone;
  
        if (value) {
          bufferedText += decoder.decode(value, { stream: true });
  
          let lines = bufferedText.split("\n");
          bufferedText = lines.pop() ?? "";
  
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const { type, data, metadata } = JSON.parse(line);
              const author = metadata?.author ?? "AIAgent";
              if (type === "status-update") {
                parser.parseChunk(data);
                //这里获取metadata的references，然后存起来
                if (metadata && Array.isArray(metadata.references)) {
                  usePresentationState.getState().setReferences(metadata.references);
                }
              } else {
                setDetailLogs([
                  ...usePresentationState.getState().detailLogs,
                  { data, metadata: author },
                ]);
              }
              //注意：⚠️在 setSlides 前强制生成新数组引用，如果同一个引用，它就不会触发 items.map(...) 渲染。
              const slides = parser.getAllSlides().map(slide => ({ ...slide }));
              slidesBufferRef.current = slides;
              slidesRafIdRef.current = requestAnimationFrame(updateSlidesWithRAF);
            } catch (e) {
              console.error("Failed to parse JSON line:", line, e);
            }
          }
        }
      }
  
      // 处理剩余行
      if (bufferedText.trim()) {
        try {
          const { type, data, metadata } = JSON.parse(bufferedText.trim());
          const author = metadata?.author ?? "AIAgent";
          if (type === "status-update") {
            parser.parseChunk(data);
            if (metadata && Array.isArray(metadata.references)) {
              usePresentationState.getState().setReferences(metadata.references);
            }
          } else {
            setDetailLogs([
              ...usePresentationState.getState().detailLogs,
              { data, metadata: author },
            ]);
          }
        } catch (e) {
          console.error("Failed to parse final stream chunk:", bufferedText.trim(), e);
        }
      }
  
      parser.finalize();
      parser.clearAllGeneratingMarks();

      const slides = parser.getAllSlides();
      console.log("slides 内容：", slides);

      // Drop any in-flight RAF so a stale parse cannot overwrite the final slides.
      if (slidesRafIdRef.current !== null) {
        cancelAnimationFrame(slidesRafIdRef.current);
        slidesRafIdRef.current = null;
      }
      slidesBufferRef.current = null;
      // Apply the completed slides synchronously. Scheduling RAF and then
      // cancelling it left Zustand on a partial parse; autosave then wrote that
      // partial PPT back over the full copy in the database.
      setSlides(slides);

      const { currentPresentationId, currentPresentationTitle, theme, language } = usePresentationState.getState();
      if (currentPresentationId) {
        void updatePresentation({
          id: currentPresentationId,
          content: { slides: slides },
          title: currentPresentationTitle ?? "",
          theme,
          language,
        });
      }

      setIsGeneratingPresentation(false);
      setShouldStartPresentationGeneration(false);
    } catch (error: any) {
      toast.error("Failed to generate presentation: " + error.message);
      resetGeneration();
      parser.reset();
      if (slidesRafIdRef.current !== null) {
        cancelAnimationFrame(slidesRafIdRef.current);
        slidesRafIdRef.current = null;
      }
    }
  };
  

  useEffect(() => {
    if (shouldStartPresentationGeneration) {
      const {
        outline,
        presentationInput,
        language,
        presentationStyle,
        currentPresentationTitle,
      } = usePresentationState.getState();

      // Reset the parser before starting a new generation
      streamingParserRef.current.reset();

      setIsGeneratingPresentation(true);

      // Start the RAF cycle for slide updates
      if (slidesRafIdRef.current === null) {
        slidesRafIdRef.current = requestAnimationFrame(updateSlidesWithRAF);
      }
      // 启动流式生成
      void generatePresentationStream({
        title: presentationInput ?? currentPresentationTitle ?? "",
        outline,
        language,
        tone: presentationStyle,
      });
    }
  }, [shouldStartPresentationGeneration]);

  // Clean up RAF on unmount
  useEffect(() => {
    return () => {
      if (slidesRafIdRef.current !== null) {
        cancelAnimationFrame(slidesRafIdRef.current);
        slidesRafIdRef.current = null;
      }

      if (outlineRafIdRef.current !== null) {
        cancelAnimationFrame(outlineRafIdRef.current);
        outlineRafIdRef.current = null;
      }
    };
  }, []);

  return null;
}