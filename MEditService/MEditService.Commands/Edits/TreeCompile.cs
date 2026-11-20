using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A plugin's tree files to the plugin written from them: compile's checks, then the write.</summary>
internal sealed class TreeCompile(SchemaReflector schemaReflector, IPluginAdapter adapter, ILogger logger)
{
    private readonly CompileLinks _links = new(adapter, logger);

    /// <summary><paramref name="tree"/> compiled to <paramref name="registered"/>'s path, which the load order need not
    /// hold. <paramref name="write"/> puts the checked plugin in place, answering whether its record was finished.</summary>
    public async Task<PluginCompileOutcome> CompileAsync(
        RegisteredPlugin registered, PluginTreeFiles tree, LoadOrderSnapshot loadOrder,
        Func<PreparedPluginSave, Answer<bool, PluginCompileOutcome>> write)
    {
        var plugin = registered.Key;
        if (!tree.RefusedFiles().Holds(out var refusedFiles, out var unread)) return SourceDoesNotParse(plugin, unread);
        if (refusedFiles.Count > 0)
        {
            return PluginCompileOutcome.Refused(
                CompileRefusal.SourceRegenerable,
                $"{plugin.Name} cannot be compiled: {string.Join("; ", refusedFiles.Select(file => $"{tree.Named(file.Path)}: {file.Reason}"))}");
        }

        var (parsedTree, deserializeRefusal) = await DeserializeSource(tree, plugin, loadOrder);
        if (deserializeRefusal != null) return deserializeRefusal;
        var compiled = parsedTree
            ?? throw new InvalidOperationException("Expected DeserializeSource to produce a tree when it does not refuse.");

        // A plugin with native records outside the range its light or medium flag limits it to would
        // compile to a binary the game mis-addresses, so refuse it (compile-plugin, Refusals).
        if (compiled.FormIdLimit(plugin.Name) is { } limited)
        {
            var outOfRange = limited.Outside(compiled.ModKey, compiled.FormKeys);
            if (outOfRange.Count > 0)
                return PluginCompileOutcome.Refused(CompileRefusal.FormIdOutsideFlagLimit, limited.Refusal(plugin.Name, outOfRange));
        }

        // Two source units claiming one FormKey can only become one binary record, so refuse rather
        // than pick a winner. Asked of the files: the reader's group cache has already resolved a
        // same-folder collision before the tree is read.
        if (!tree.CollidingFormKeys(compiled.FormKeys).Holds(out var collidingFormKeys, out unread))
            return SourceDoesNotParse(plugin, unread);
        if (collidingFormKeys.Count > 0)
        {
            return PluginCompileOutcome.Refused(
                CompileRefusal.FormKeyCollision,
                $"{plugin.Name} cannot be compiled: more than one source file claims the same FormKey — " +
                $"{string.Join(", ", collidingFormKeys)}.");
        }

        if (!tree.Compare(await compiled.SerializeTreeAsync()).Holds(out var comparison, out unread))
            return SourceDoesNotParse(plugin, unread);
        if (RefuseIfSourceDoesNotRoundTrip(comparison.Divergences, plugin, tree) is { } roundTripRefusal) return roundTripRefusal;

        var content = ContentFacts(compiled, plugin, loadOrder);

        var loadOrderNames = loadOrder.InJudgedOrder().Select(c => c.Name).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        var saved = await compiled.SaveAsync(registered.Path, loadOrderNames, content.Masters, save => Land(save, compiled, plugin, tree, write));
        if (!saved.Holds(out var landed, out var failure))
        {
            return failure switch
            {
                PluginFailure.PrunedMaster => PluginCompileOutcome.Refused(CompileRefusal.FormIdUnmappable, $"{plugin.Name} could not be compiled: {failure.Reason}"),
                PluginFailure.MasterNotInLoadOrder => PluginCompileOutcome.Refused(CompileRefusal.MasterNotInLoadOrder, $"{plugin.Name} could not be compiled: {failure.Reason}"),
                PluginFailure.MasterUnreadable master => PluginCompileOutcome.Refused(
                    CompileRefusal.MasterUnreadable,
                    $"{plugin.Name} could not be compiled: {failure.Reason} Fix or restore {master.Master}, then compile again."),
                _ => WriteFailed(plugin, failure.Reason),
            };
        }
        if (!landed.Holds(out var recorded, out var refused)) return refused;

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Compiled {Plugin} ({Origin}) from {RecordCount} source records",
                plugin.Name, plugin.Origin, compiled.FormKeys.Count);
        }
        var diagnostics = _links.Report(new LinkCheckScope(plugin, registered, loadOrder, tree), content.Records, content.Links);
        diagnostics.AddRange(comparison.Misplaced.Select(MisplacedDiagnostic));
        if (!recorded)
        {
            logger.LogWarning("{Plugin} compiled, but the record of the binary Modbench last wrote could not be finished", plugin.Name);
            diagnostics.Add(CompileDiagnostic.OfTheBuild(
                $"{plugin.Name} compiled, but the record of the binary Modbench last wrote could not be finished. " +
                "Compile it again to update the record."));
        }
        return PluginCompileOutcome.Success(diagnostics);
    }

    internal static PluginCompileOutcome SourceDoesNotParse(PluginAddress plugin, SourceFailure unread) =>
        PluginCompileOutcome.Refused(
            unread.DecompileRepairs ? CompileRefusal.SourceRegenerable : CompileRefusal.SourceDoesNotParse,
            $"{plugin.Name} could not be read from its source: {unread.Reason}");

    internal static PluginCompileOutcome WriteFailed(PluginAddress plugin, string reason) =>
        PluginCompileOutcome.Refused(
            CompileRefusal.WriteFailed, $"Could not write {plugin.Name}: {reason} Its source is untouched, so compiling again rebuilds it.");

    private static Answer<bool, PluginCompileOutcome> Land(
        PreparedPluginSave save, CompiledTree compiled, PluginAddress plugin, PluginTreeFiles tree,
        Func<PreparedPluginSave, Answer<bool, PluginCompileOutcome>> write) =>
        compiled.DropsIn(save) is { Count: > 0 } drops ? Dropped(plugin, tree, drops) : write(save);

    private static PluginCompileOutcome Dropped(PluginAddress plugin, PluginTreeFiles tree, IReadOnlyList<DroppedValue> drops)
    {
        var named = new List<string>();
        foreach (var drop in drops)
        {
            if (!tree.Named(drop.Record).Holds(out var held, out var unread)) return SourceDoesNotParse(plugin, unread);
            named.Add($"in {held}, '{drop.Field}'");
        }
        return PluginCompileOutcome.Refused(
            CompileRefusal.SourceValueDropped,
            $"{plugin.Name} cannot be compiled: the plugin written from its source would not hold, {string.Join("; ", named)}. Nothing was written.");
    }

    private sealed record Content(IReadOnlyList<SourceRecord> Records, IReadOnlyCollection<string> Links, IReadOnlySet<string> Masters);

    private Content ContentFacts(CompiledTree compiled, PluginAddress plugin, LoadOrderSnapshot loadOrder)
    {
        // One walk, and the record type is the one RecordTableName gives, so what compile files a
        // record under and what the tree calls it cannot differ.
        var schemas = schemaReflector.GetSchemas(loadOrder.GameRelease);
        var records = new List<SourceRecord>();
        var required = new RequiredMasters(plugin);
        foreach (var document in compiled.Documents())
        {
            var schema = schemas[document.RecordType];
            records.Add(new SourceRecord(document.RecordType, schema, document, DocumentTokens.EditorIdIn(document.Text).EditorId));
            required.Add(document, schema);
        }

        return new Content(records, required.Links, required.Masters);
    }

    private async Task<(CompiledTree? Tree, PluginCompileOutcome? Refusal)> DeserializeSource(
        PluginTreeFiles tree, PluginAddress plugin, LoadOrderSnapshot loadOrder)
    {
        if ((await adapter.ReadTreeAsync(tree.Files, loadOrder)).Holds(out var compiled, out var failure)) return (compiled, null);

        logger.LogWarning("{Plugin} could not be read from its source: {Reason}", plugin.Name, failure.Reason);
        if (failure is PluginFailure.Unparsed unparsed && tree.Named(unparsed.Diagnosis).Holds(out var named, out _))
            return (null, PluginCompileOutcome.Refused(CompileRefusal.SourceDoesNotParse, $"{plugin.Name} could not be read from its source: {named.Describe()}"));
        return (null, PluginCompileOutcome.Refused(CompileRefusal.SourceRegenerable, $"{plugin.Name} could not be read from its source: {failure.Reason}"));
    }

    // ADR-0006. The generated deserializer skips an unrecognized property or file without
    // throwing, so a successful parse proves nothing.
    // No live subrecord-inventory gate here, deliberately: that loss class arises only when init
    // parses an external binary, never from Compile.
    private static PluginCompileOutcome? RefuseIfSourceDoesNotRoundTrip(IReadOnlyList<SourceDivergence> found, PluginAddress plugin, PluginTreeFiles tree)
    {
        if (found.Count == 0) return null;

        return PluginCompileOutcome.Refused(
            found.Any(divergence => divergence.Kind == SourceDivergenceKind.Unproduced) ? CompileRefusal.SourceRegenerable : CompileRefusal.SourceDoesNotParse,
            $"{plugin.Name} does not round-trip through its own source: {string.Join("; ", found.Select(divergence => Describe(divergence, tree)))}.");
    }

    private static string Describe(SourceDivergence divergence, PluginTreeFiles tree)
    {
        if (divergence.Kind == SourceDivergenceKind.Unproduced)
        {
            return $"{tree.Named(divergence.Path)} is in the source, but the current codec produces no such file from it, so nothing it " +
                "holds reaches the plugin (a document left over from an earlier source layout, or a stray file)";
        }

        var offender = divergence.Kind == SourceDivergenceKind.HeaderChanged ? "the plugin header" : tree.Named(divergence.Path);
        var field = divergence.Field is null ? "" : $": {divergence.Field}";
        return $"{offender}{field} does not match what the current codec would produce from it";
    }

    private static CompileDiagnostic MisplacedDiagnostic(MisplacedFile file) =>
        new(file.FormKey, file.HeldPath, file.Message);
}
