using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex;

/// <summary>A plugin mEdit wrote: the files the write names, and the documents written among them.</summary>
public sealed record HandedPlugin(PluginAddress Plugin, IReadOnlyList<string> Files, IReadOnlyList<WrittenDocument> Documents);

/// <summary>Where a writer hands the record index what it wrote (ADR-0029).</summary>
public interface IHandedWrites
{
    /// <summary>Answers once the record index holds each plugin <paramref name="written"/> names, or once a check of the disk
    /// has read it when null; else why not.</summary>
    Task<string?> Hold(IReadOnlyList<HandedPlugin>? written, CancellationToken cancel);
}
