import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted [animation-duration:2.5s]", className)}
      {...props}
    />
  )
}

function SkeletonText({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="skeleton-text" className={cn("flex w-full max-w-xs flex-col gap-2", className)} {...props}>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  )
}

export { Skeleton, SkeletonText }
