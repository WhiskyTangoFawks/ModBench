using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>ADR-0007's compile, for one plugin.</summary>
internal sealed class PluginCompileService(
    LoadOrderHolder loadOrderHolder,
    SchemaReflector schemaReflector,
    IPluginAdapter adapter,
    ISourceAdapter source,
    ILogger<PluginCompileService> logger)
{
    private readonly CompileLinks _links = new(adapter, logger);

    // A tracked mod refuses Track, so decompile is the way back (ADR-0007).
    private const string RegenerateTheSource = "Decompile the plugin to regenerate the source.";

    public async Task<CompileResult> CompileAsync(PluginAddress plugin)
    {
        var loadOrder = loadOrderHolder.Current;
        if (loadOrder.Plugin(plugin) is not { } registered)
            return CompileResult.Refused(CompileRefusal.PluginNotInLoadOrder, $"{plugin.Name} is not in the load order.");
        if (registered.Provider is not PluginProvider.FromMod mod || !source.IsTracked(registered))
            return CompileResult.Refused(CompileRefusal.PluginNotTracked, $"{plugin.Name} is not tracked, so there is no source to compile.");

        if (source.WhySourceDoesNotRead(registered) is { } why)
        {
            return CompileResult.Refused(
                CompileRefusal.PluginSourceUnreadable,
                $"{plugin.Name}'s plugin source is unreadable, so it cannot be compiled: {why.Reason}" +
                (why.DecompileRepairs ? $" {RegenerateTheSource}" : ""));
        }

        // One repository for the whole pass, so the tree it answers from is read once.
        var repository = source.OverFolder(mod, loadOrder.GameRelease);
        if (!repository.TreeOf(plugin).Holds(out var sourceFiles, out var unread)) return SourceDoesNotParse(plugin, unread);

        // A document the read could not open is content this compile does not have, and compiling the
        // rest would write a binary missing that record with nothing left to notice it
        // (ADR-0019).
        if (sourceFiles.Unreadable is { } unreadable)
        {
            return CompileResult.Refused(
                CompileRefusal.SourceFileHeld,
                $"{plugin.Name} could not be read from its source: {unreadable} could not be opened. " +
                "Another program may be holding it; close it and compile again.");
        }

        var files = sourceFiles.Files;
        if (files.Count == 0)
        {
            return CompileResult.Refused(
                CompileRefusal.NoSource,
                $"{plugin.Name}'s source folder holds no files, so there is nothing to compile. {RegenerateTheSource}");
        }

        if (!repository.RefusedFilesOf(plugin).Holds(out var refusedFiles, out unread)) return SourceDoesNotParse(plugin, unread);
        if (refusedFiles.Count > 0)
        {
            return CompileResult.Refused(
                CompileRefusal.SourceDoesNotParse,
                $"{plugin.Name} cannot be compiled: {string.Join("; ", refusedFiles.Select(file => $"{file.Path}: {file.Reason}"))}");
        }

        var (parsedTree, deserializeRefusal) = await DeserializeSource(files, plugin, repository, loadOrder);
        if (deserializeRefusal != null)
            return CompileResult.Refused(CompileRefusal.SourceDoesNotParse, deserializeRefusal);
        var tree = parsedTree
            ?? throw new InvalidOperationException("Expected DeserializeSource to produce a tree when it does not refuse.");

        // A plugin with native records outside the range its light or medium flag limits it to would
        // compile to a binary the game mis-addresses, so refuse it (compile-plugin, Refusals).
        if (tree.FormIdLimit(plugin.Name) is { } limited)
        {
            var outOfRange = limited.Outside(tree.ModKey, tree.FormKeys);
            if (outOfRange.Count > 0)
                return CompileResult.Refused(CompileRefusal.FormIdOutsideFlagLimit, limited.Refusal(plugin.Name, outOfRange));
        }

        // Two source units claiming one FormKey can only become one binary record, so refuse rather
        // than pick a winner. Asked of the files: the reader's group cache has already resolved a
        // same-folder collision before the tree is read.
        if (!repository.CollidingFormKeys(plugin, tree.FormKeys).Holds(out var collidingFormKeys, out unread))
            return SourceDoesNotParse(plugin, unread);
        if (collidingFormKeys.Count > 0)
        {
            return CompileResult.Refused(
                CompileRefusal.FormKeyCollision,
                $"{plugin.Name} cannot be compiled: more than one source file claims the same FormKey — " +
                $"{string.Join(", ", collidingFormKeys)}.");
        }

        if (!repository.Compare(plugin, await tree.SerializeTreeAsync()).Holds(out var comparison, out unread))
            return SourceDoesNotParse(plugin, unread);
        var roundTripRefusal = RefuseIfSourceDoesNotRoundTrip(comparison.Divergences, plugin);
        if (roundTripRefusal != null)
            return CompileResult.Refused(CompileRefusal.SourceDoesNotRoundTrip, roundTripRefusal);

        var content = ContentFacts(tree, plugin, loadOrder);

        var loadOrderNames = loadOrder.InJudgedOrder().Select(c => c.Name).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        var saved = await tree.SaveAsync(registered.Path, loadOrderNames, content.Masters, save => Land(save, tree, plugin, repository));
        if (!saved.Holds(out var landed, out var failure))
        {
            return failure switch
            {
                PluginFailure.PrunedMaster => CompileResult.Refused(CompileRefusal.FormIdUnmappable, $"{plugin.Name} could not be compiled: {failure.Reason}"),
                PluginFailure.MasterNotInLoadOrder => CompileResult.Refused(CompileRefusal.MasterNotInLoadOrder, $"{plugin.Name} could not be compiled: {failure.Reason}"),
                PluginFailure.MasterUnreadable master => CompileResult.Refused(
                    CompileRefusal.MasterUnreadable,
                    $"{plugin.Name} could not be compiled: {failure.Reason} Fix or restore {master.Master}, then compile again."),
                _ => WriteFailed(plugin, failure.Reason),
            };
        }
        if (!landed.Holds(out var recorded, out var refused)) return refused;

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Compiled {Plugin} ({Origin}) from {RecordCount} source records",
                plugin.Name, plugin.Origin, tree.FormKeys.Count);
        }
        var diagnostics = _links.Report(new LinkCheckScope(plugin, registered, loadOrder, repository), content.Records, content.Links);
        diagnostics.AddRange(comparison.Misplaced.Select(MisplacedDiagnostic));
        if (!recorded)
        {
            diagnostics.Add(CompileLinks.PluginDiagnostic(
                plugin, repository,
                $"{plugin.Name} compiled, but the record of the binary Modbench last wrote could not be finished. " +
                "Compile it again to update the record."));
        }
        return CompileResult.Success(diagnostics);
    }

    private static Answer<bool, CompileResult> Land(PreparedPluginSave save, CompiledTree tree, PluginAddress plugin, ISourceRepository repository)
    {
        if (tree.DropsIn(save) is { Count: > 0 } drops) return Dropped(plugin, repository, drops);
        return repository.WriteBinary(plugin, save.BinarySha256(), save.Commit).Holds(out var recorded, out var unwritten)
            ? recorded
            : WriteFailed(plugin, unwritten.Reason);
    }

    private static CompileResult Dropped(PluginAddress plugin, ISourceRepository repository, IReadOnlyList<DroppedValue> drops)
    {
        var named = new List<string>();
        foreach (var drop in drops)
        {
            if (!repository.RelativePathOf(plugin, drop.Record).Holds(out var file, out var unread)) return SourceDoesNotParse(plugin, unread);
            var held = file ?? throw new InvalidOperationException($"Expected the tree this compile read to hold {drop.Record.FormKey}'s document.");
            named.Add($"in {held}, {string.Join(", ", drop.Paths.Select(path => $"'{path}'"))}");
        }
        return CompileResult.Refused(
            CompileRefusal.SourceValueDropped,
            $"{plugin.Name} cannot be compiled: the plugin written from its source would not hold, {string.Join("; ", named)}. Nothing was written.");
    }

    private static CompileResult SourceDoesNotParse(PluginAddress plugin, SourceFailure unread) =>
        CompileResult.Refused(CompileRefusal.SourceDoesNotParse, $"{plugin.Name} could not be read from its source: {unread.Reason}");

    private static CompileResult WriteFailed(PluginAddress plugin, string reason) =>
        CompileResult.Refused(
            CompileRefusal.WriteFailed, $"Could not write {plugin.Name}: {reason} Its source is untouched, so compiling again rebuilds it.");

    private sealed record Content(IReadOnlyList<SourceRecord> Records, IReadOnlyCollection<string> Links, IReadOnlySet<string> Masters);

    // The links come from the records here, through the collector and the schema.
    private Content ContentFacts(CompiledTree tree, PluginAddress plugin, LoadOrderSnapshot loadOrder)
    {
        // One walk, and the record type is the one RecordTableName gives, so what compile files a
        // record under and what the tree calls it cannot differ.
        var schemas = schemaReflector.GetSchemas(loadOrder.GameRelease);
        var records = new List<SourceRecord>();
        var required = new RequiredMasters(plugin);
        foreach (var document in tree.Documents())
        {
            var schema = schemas[document.RecordType];
            records.Add(new SourceRecord(document.RecordType, schema, document, DocumentTokens.EditorIdIn(document.Text).EditorId));
            required.Add(document, schema);
        }

        return new Content(records, required.Links, required.Masters);
    }

    private async Task<(CompiledTree? Tree, string? RefusalReason)> DeserializeSource(
        IReadOnlyList<TreeFile> files, PluginAddress plugin, ISourceRepository repository, LoadOrderSnapshot loadOrder)
    {
        if ((await adapter.ReadTreeAsync(files, loadOrder)).Holds(out var tree, out var failure)) return (tree, null);

        logger.LogWarning("{Plugin} could not be read from its source: {Reason}", plugin.Name, failure.Reason);
        var why = failure is PluginFailure.Unparsed unparsed && repository.InSourceNames(plugin, unparsed.Diagnosis).Holds(out var named, out _)
            ? named.Describe()
            : failure.Reason;
        return (null, $"{plugin.Name} could not be read from its source: {why} {RegenerateTheSource}");
    }

    // ADR-0006. The generated deserializer skips an unrecognized property or file without
    // throwing, so a successful parse proves nothing.

    // No live subrecord-inventory gate here, deliberately: that loss class arises only when Track
    // parses an external binary, never from Compile.
    private static string? RefuseIfSourceDoesNotRoundTrip(IReadOnlyList<SourceDivergence> found, PluginAddress plugin)
    {
        if (found.Count == 0) return null;

        var remedy = found.Any(divergence => divergence.Kind == SourceDivergenceKind.Unproduced) ? $" {RegenerateTheSource}" : "";
        return $"{plugin.Name} does not round-trip through its own source: {string.Join("; ", found.Select(Describe))}.{remedy}";
    }

    private static string Describe(SourceDivergence divergence)
    {
        if (divergence.Kind == SourceDivergenceKind.Unproduced)
        {
            return $"{divergence.Path} is in the source, but the current codec produces no such file from it, so nothing it " +
                "holds reaches the plugin (a document left over from an earlier source layout, or a stray file)";
        }

        var offender = divergence.Kind == SourceDivergenceKind.HeaderChanged ? "the plugin header" : divergence.Path;
        var field = divergence.Field is null ? "" : $": {divergence.Field}";
        return $"{offender}{field} does not match what the current codec would produce from it";
    }

    private static CompileDiagnostic MisplacedDiagnostic(MisplacedFile file) =>
        new(file.FormKey, file.HeldPath, file.Message);
}
