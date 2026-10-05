using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>ADR-0007's compile, for one plugin.</summary>
public sealed class PluginCompileService(
    LoadOrderHolder loadOrderHolder,
    SchemaReflector schemaReflector,
    RecordTextCodec codec,
    IPluginAdapter adapter,
    ILogger<PluginCompileService> logger)
{
    private readonly CompileLinks _links = new(adapter, schemaReflector, logger);

    // The palette entry verbatim; a tracked mod refuses Track, so decompile is the way back
    // (ADR-0007).
    private const string RegenerateTheSource = "Run \"Modbench: Decompile Plugin\" to regenerate the source.";

    public async Task<CompileResult> CompileAsync(PluginAddress plugin)
    {
        var loadOrder = loadOrderHolder.Current;
        if (loadOrder.Plugins.Count == 0)
            return CompileResult.Refused("No load order has been received.");
        if (loadOrder.Plugin(plugin) is not { } registered)
            return CompileResult.Refused($"{plugin.Name} is not in the load order.");
        if (SourceRepository.TrackedModOf(loadOrder, plugin) is not { } mod)
            return CompileResult.Refused($"{plugin.Name} is not tracked, so there is no source to compile.");

        // One repository for the whole pass, so the tree it answers from is read once.
        var repository = SourceRepository.Over(mod, loadOrder.GameRelease);
        var sourceFiles = repository.FilesOf(plugin);

        // A document the read could not open is content this compile does not have, and compiling the
        // rest would write a binary missing that record with nothing left to notice it
        // (ADR-0019).
        if (sourceFiles.Unreadable is { } unreadable)
        {
            return CompileResult.Refused(
                $"{plugin.Name} could not be read from its source: {unreadable} could not be opened. " +
                "Another program may be holding it; close it and compile again.");
        }

        var files = sourceFiles.Files;
        if (files.Count == 0)
        {
            return CompileResult.Refused(
                $"{plugin.Name} has no source tree in the working tree, so there is nothing to compile.");
        }

        var (parsedTree, deserializeRefusal) = await DeserializeSource(files, plugin.Name, loadOrder.GameRelease);
        if (deserializeRefusal != null)
            return CompileResult.Refused(deserializeRefusal);
        var tree = parsedTree
            ?? throw new InvalidOperationException("Expected DeserializeSource to produce a tree when it does not refuse.");

        // A light plugin with native records outside the light FormID range would compile to a
        // binary the game mis-addresses, so refuse it (compile-plugin, Refusals).
        if (tree.IsLight(plugin.Name) && tree.SmallMasterRange is { } lightRange)
        {
            var outOfRange = tree.FormKeys
                .Where(key => key.ModKey == tree.ModKey
                    && (key.ID < lightRange.Min || key.ID > lightRange.Max))
                .Select(key => key.ToString())
                .ToList();
            if (outOfRange.Count > 0)
            {
                return CompileResult.Refused(
                    $"{plugin.Name} is a light plugin but holds native FormID(s) outside the light range " +
                    $"(0x{lightRange.Min:X}-0x{lightRange.Max:X}): {string.Join(", ", outOfRange.Take(4))}" +
                    (outOfRange.Count > 4 ? $" and {outOfRange.Count - 4} more" : "") +
                    ". Clear the light flag, rename the plugin off .esl, or change the records' FormIDs.");
            }
        }

        // Two source units claiming one FormKey can only become one binary record, so refuse rather
        // than pick a winner. Asked of the files: the reader's group cache has already resolved a
        // same-folder collision before the tree is read.
        var collidingFormKeys = repository.CollidingFormKeys(plugin, tree.FormKeys);
        if (collidingFormKeys.Count > 0)
        {
            return CompileResult.Refused(
                $"{plugin.Name} cannot be compiled: more than one source file claims the same FormKey — " +
                $"{string.Join(", ", collidingFormKeys)}.");
        }

        var roundTripRefusal = await RefuseIfSourceDoesNotRoundTrip(tree, plugin, repository);
        if (roundTripRefusal != null)
            return CompileResult.Refused(roundTripRefusal);

        var content = ContentFacts(tree, plugin, loadOrder);

        var loadOrderNames = loadOrder.Active.Select(c => c.Name).ToList();

        PreparedPluginSave save;
        try
        {
            save = await tree.PrepareSaveAsync(registered.Path, loadOrderNames);
        }
        catch (Exception ex) when (PluginDiagnosis.HasUnmappableFormID(ex))
        {
            // A struct-list script property's FormLink is invisible to Mutagen's EnumerateFormLinks
            // (Mutagen issue 688), so the content-derived master pass (ADR-0008) prunes a
            // master this write still needs. Every other write failure propagates raw.
            return CompileResult.Refused(
                $"{plugin.Name} could not be compiled: {PluginDiagnosis.FromWriteException(ex).Describe()}");
        }
        using (save)
        {
            repository.WriteBinary(plugin, save.BinarySha256(), save.Commit);
        }

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Compiled {Plugin} ({Origin}) from {RecordCount} source records",
                plugin.Name, plugin.Origin, tree.FormKeys.Count);
        }
        return CompileResult.Success(_links.Report(new CompiledPlugin(plugin, registered, loadOrder, repository), content.Records, content.Links), content.Masters);
    }

    private sealed record Content(
        IReadOnlyList<SourceRecord> Records, IReadOnlyList<string> Masters, IReadOnlyCollection<string> Links);

    // The masters come from the records here, through the collector and the schema
    // (ADR-0008; ADR-0015).
    private Content ContentFacts(CompiledTree tree, PluginAddress plugin, LoadOrderSnapshot loadOrder)
    {
        // One walk, and the record type is the one RecordTableName gives, so what compile files a
        // record under and what the tree calls it cannot differ. A type no schema claims has no
        // document, so nothing is derived from it.
        var schemas = schemaReflector.GetSchemas(loadOrder.GameRelease);
        var records = new List<SourceRecord>();
        var required = new RequiredMasters(plugin);
        foreach (var document in tree.Documents(schemas))
        {
            var schema = schemas[document.RecordType];
            records.Add(new SourceRecord(document.RecordType, schema, document, WriteTargets.EditorIdOf(document.Text)));
            required.Add(document, schema);
        }

        return new Content(records, InLoadOrderOrder(required.Masters, loadOrder), required.Links);
    }

    // An active master sorts by its load index; one that is not falls after every active master,
    // alphabetically among themselves, so the result is stable either way.
    private static IReadOnlyList<string> InLoadOrderOrder(IReadOnlySet<string> masters, LoadOrderSnapshot loadOrder)
    {
        if (masters.Count == 0) return [];

        var loadIndex = loadOrder.Active
            .Select((plugin, index) => (plugin.Name, index))
            .ToDictionary(p => p.Name, p => p.index, StringComparer.OrdinalIgnoreCase);

        return [.. masters
            .OrderBy(m => loadIndex.GetValueOrDefault(m, int.MaxValue))
            .ThenBy(m => m, StringComparer.OrdinalIgnoreCase)];
    }

    private async Task<(CompiledTree? Tree, string? RefusalReason)> DeserializeSource(
        IReadOnlyList<TreeFile> files, string pluginName, GameRelease release)
    {
        var read = await adapter.ReadTreeAsync(files, codec, release);
        if (read.Tree is { } tree) return (tree, null);

        logger.LogWarning(read.Error, "{Plugin} could not be read from its source", pluginName);
        var diagnosis = read.Diagnosis
            ?? throw new InvalidOperationException("Expected a failed read to carry a diagnosis.");
        return (null, $"{pluginName} could not be read from its source: {diagnosis.Describe()} {RegenerateTheSource}");
    }

    // ADR-0006. The generated deserializer skips an unrecognized property or file without
    // throwing, so a successful parse proves nothing.

    // No live subrecord-inventory gate here, deliberately: that loss class arises only when Track
    // parses an external binary, never from Compile.
    private static async Task<string?> RefuseIfSourceDoesNotRoundTrip(
        CompiledTree tree, PluginAddress plugin, SourceRepository repository)
    {
        if (repository.DivergenceFrom(plugin, await tree.SerializeTreeAsync()) is not { } divergence) return null;

        if (divergence.Kind != SourceDivergenceKind.Unproduced)
        {
            var offender = divergence.Kind == SourceDivergenceKind.HeaderChanged ? "the plugin header" : divergence.Path;
            return $"{plugin.Name} does not round-trip through its own source: {offender} does not match " +
                $"what the current codec would produce from it. {RegenerateTheSource}";
        }

        return $"{plugin.Name} does not round-trip through its own source: {divergence.Path} is in the source, " +
            "but the current codec produces no such file from it, so nothing it holds reaches the plugin " +
            $"(a document left over from an earlier source layout, or a stray file). {RegenerateTheSource}";
    }
}
