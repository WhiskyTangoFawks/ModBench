using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex.Queries;

/// <summary>A plugin mEdit wrote: the files the write names, and the documents written among them.</summary>
public sealed record HandedPlugin(PluginAddress Plugin, IReadOnlyList<string> Files, IReadOnlyList<WrittenDocument> Documents);
