using System.Diagnostics;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>ADR-0007: tracked and untracked plugins share one indexing call.</summary>
internal static class SourceIngest
{
    /// <summary>Whether this plugin has a tree to ingest from; false reads the binary instead.
    /// Re-derived every call — MO2's Replace install shell-deletes the folder.</summary>
    internal static bool HoldsTree(string origin, string pluginPath, string pluginName) =>
        LoadOrderSnapshot.ModFolderOf(origin, pluginPath) is { } modFolder
        && SourceRepository.HoldsTreeFor(modFolder, pluginName);

    /// <summary>Indexes the whole tree as the key. Throws whatever the tree throws: "quietly served the
    /// binary instead" is a silent lie. <paramref name="binaryPath"/> only stamps the rows; null
    /// claims no file backs them.</summary>
    internal static void Ingest(
        IRecordIndex index, string modFolder, Registration registration,
        PluginAddress key, string? binaryPath, GameRelease gameRelease, SchemaReflector schemaReflector,
        ILogger logger, CancellationToken cancel = default)
    {
        cancel.ThrowIfCancellationRequested();
        var schemas = schemaReflector.GetSchemas(gameRelease);

        // Over rather than Open: the documents read the same either way, and a repository verb over an
        // untracked folder answers empty instead of throwing.
        var repository = SourceRepository.Over(modFolder, gameRelease);

        var timer = Stopwatch.StartNew();
        using (var documents = repository.OpenDocuments(key, schemas))
            index.Index(documents, registration, key, binaryPath, DerivedFrom.SourceTree);
        var indexMs = timer.ElapsedMilliseconds;

        timer.Restart();
        index.LearnWorkingTreeStates(key, modFolder);
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug(
                "Ingested {Plugin} from source: index {IndexMs} ms, working tree states {StatesMs} ms",
                key.Name, indexMs, timer.ElapsedMilliseconds);
        }
    }
}
