namespace MEditService.Commands;

/// <summary>The answer of a write that answers nothing else: each file it wrote, or a folder holding them (ADR-0029).</summary>
public sealed record FilesWritten(IReadOnlyList<string> Written);
