using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>ADR-0007's Save &amp; Compile: source (working tree or a named git ref) to binary. Reads
/// the source's own bytes, never the DB index; refuses only what it structurally cannot emit, and
/// the rest becomes diagnostics.</summary>
public sealed class PluginCompileService(
    LoadOrderHolder loadOrderHolder,
    SchemaReflector schemaReflector,
    RecordTextCodec codec,
    IPluginAdapter adapter,
    PluginWriter writer,
    ILogger<PluginCompileService> logger)
{
    public CompileResult Compile(PluginKey plugin, CompileSource source)
    {
        var loadOrder = loadOrderHolder.Current;
        if (loadOrder.Copies.Count == 0)
            return CompileResult.Refused("No load order has been received.");
        if (loadOrder.Copy(plugin) is not { } copy)
            return CompileResult.Refused($"{plugin.Name} is not in the load order.");
        if (SourceRepository.TrackedModFolderOf(loadOrder, plugin) is not { } modFolder)
            return CompileResult.Refused($"{plugin.Name} is not tracked, so there is no source to compile.");

        // One repository for the whole pass, so the tree it answers from is read once: everything below
        // asks it for the same source, the working tree or a named ref.
        var atRef = source is CompileSource.AtRef atRefSource ? atRefSource.Ref : null;
        var repository = SourceRepository.Over(modFolder, loadOrder.GameRelease);
        var sourceFiles = repository.FilesOf(plugin, atRef);

        // A document the read could not open is content this compile does not have, and compiling the
        // rest would write a binary missing that record with nothing left to notice it (ADR-0003).
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
                $"{plugin.Name} has no source tree at {atRef ?? "the working tree"}, so there is nothing to compile.");
        }

        var (parsedTree, deserializeRefusal) = DeserializeSource(files, plugin.Name, loadOrder.GameRelease);
        if (deserializeRefusal != null)
            return CompileResult.Refused(deserializeRefusal);
        var tree = parsedTree!;

        // An ESL-addressable plugin with native records outside the light FormID range would compile
        // to a binary the game mis-addresses, so refuse it. Only a header flag can be removed; a
        // plugin light by .esl extension needs renaming.
        if (tree.IsLight(plugin.Name) && tree.SmallMasterRange is { } lightRange)
        {
            var outOfRange = tree.FormKeys
                .Where(key => key.ModKey == tree.ModKey
                    && (key.ID < lightRange.Min || key.ID > lightRange.Max))
                .Select(key => key.ToString())
                .ToList();
            if (outOfRange.Count > 0)
            {
                var flagRemovable = tree.IsSmallMaster;
                var remedy = flagRemovable
                    ? "Remove the ESL flag (the header's IsSmallMaster member), or renumber the record(s) into the light range."
                    : "Rename the plugin off the .esl extension, or renumber the record(s) into the light range.";
                return CompileResult.Refused(
                    $"{plugin.Name} is ESL-addressable but holds native FormID(s) outside the light range " +
                    $"(0x{lightRange.Min:X}-0x{lightRange.Max:X}): {string.Join(", ", outOfRange.Take(4))}" +
                    (outOfRange.Count > 4 ? $" and {outOfRange.Count - 4} more" : "") +
                    $". {remedy}",
                    eslContradiction: flagRemovable);
            }
        }

        // Two source units claiming one FormKey can only become one binary record, so refuse rather
        // than pick a winner. Asked of the files: the reader's group cache has already resolved a
        // same-folder collision before the tree is read.
        var collidingFormKeys = repository.CollidingFormKeys(plugin, tree.FormKeys, atRef);
        if (collidingFormKeys.Count > 0)
        {
            return CompileResult.Refused(
                $"{plugin.Name} cannot be compiled: more than one source file claims the same FormKey — " +
                $"{string.Join(", ", collidingFormKeys)}.");
        }

        var roundTripRefusal = RefuseIfSourceDoesNotRoundTrip(tree, plugin.Name, files);
        if (roundTripRefusal != null)
            return CompileResult.Refused(roundTripRefusal);

        var content = ContentFacts(tree, plugin, loadOrder);

        var loadOrderNames = loadOrder.Copies
            .Where(c => c.Registration.InLoadOrder)
            .OrderBy(c => c.Slot!.Value)
            .Select(c => c.Name)
            .ToList();

        // A crash mid-flight is what the journal marker is for: only the unmappable-FormID shape is
        // caught, so any other throw leaves it crash-shaped. PluginWriter never touches the plugin
        // until Commit(), so refusing is safe.
        string? writeRefusal = null;
        CompileJournal.RunBatch(modFolder, [plugin.Name], _ =>
        {
            try
            {
                tree.SaveThroughAsync(writer, copy.Path, loadOrderNames).GetAwaiter().GetResult();
            }
            catch (Exception ex) when (PluginDiagnosis.HasUnmappableFormID(ex))
            {
                // A struct-list script property's FormLink is invisible to Mutagen's EnumerateFormLinks
                // (Mutagen issue 688), so the content-derived master pass (ADR-0008) prunes a
                // master this write still needs. Every other write failure propagates raw.
                writeRefusal = $"{plugin.Name} could not be compiled: {PluginDiagnosis.FromWriteException(ex).Describe()}";
                return false;
            }

            // The parked snapshot advances only after the binary write has landed. An AtRef compile
            // parks too: otherwise the parked trailer still names the old working-tree hash and
            // Modbench's own write reads as an external change.
            SourceRepository.ParkCompileSnapshot(
                modFolder, plugin.Name, atRef, PluginBinaryHash.TrailerFormOfFile(copy.Path));
            return true;
        });
        if (writeRefusal != null)
            return CompileResult.Refused(writeRefusal);

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Compiled {Plugin} ({Origin}) from {RecordCount} source records",
                plugin.Name, plugin.Origin, tree.FormKeys.Count);
        }
        return CompileResult.Success(Reported(content, plugin, copy, loadOrder, repository, atRef), content.Masters);
    }

    // The binary is written and the snapshot parked, so the report is the only thing left to go
    // wrong: it becomes a diagnostic saying so, never a refusal of a compile that happened.
    private List<CompileDiagnostic> Reported(
        Content content, PluginKey plugin, RegisteredCopy copy, LoadOrderSnapshot loadOrder,
        SourceRepository repository, string? atRef)
    {
        try
        {
            return LinkDiagnostics(content, plugin, copy, loadOrder, repository, atRef);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogWarning(ex, "{Plugin} compiled, but its link check did not run", plugin.Name);
            return [PluginDiagnostic(
                plugin, $"{plugin.Name} compiled, but its links could not be checked: {ex.Message}")];
        }
    }

    private sealed record SourceRecord(
        string RecordType, RecordTableSchema Schema, PluginDocument Document, string? EditorId);

    private sealed record Content(
        IReadOnlyList<SourceRecord> Records, IReadOnlyList<string> Masters, IReadOnlyCollection<string> Links);

    // ADR-0015 invariant 1: the write side never reads the Index, so the masters content requires
    // (ADR-0008) come from the records here, through the collector and the schema.
    private Content ContentFacts(CompiledTree tree, PluginKey plugin, LoadOrderSnapshot loadOrder)
    {
        // One walk, and the record type is the one RecordTableName gives, so what compile files a
        // record under and what the tree calls it cannot differ. A type no schema claims has no
        // document, so nothing is derived from it.
        var schemas = schemaReflector.GetSchemas(loadOrder.GameRelease);
        var records = new List<SourceRecord>();
        foreach (var document in tree.Documents(schemas))
        {
            records.Add(new SourceRecord(
                document.RecordType, schemas[document.RecordType], document,
                WriteTargets.EditorIdOf(document.Text)));
        }

        var links = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var masters = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var record in records)
        {
            // An override carries another plugin's FormKey, which needs that plugin as a master
            // whether or not the record references anything.
            if (PluginNameIn(record.Document.FormKey) is { } native) masters.Add(native);

            using var document = JsonDocument.Parse(record.Document.Text);
            var referenced = FormReferences.Collect(document.RootElement, record.Schema)
                .Select(reference => reference.TargetFormKey);
            foreach (var target in referenced)
            {
                links.Add(target);
                if (PluginNameIn(target) is { } master) masters.Add(master);
            }
        }

        masters.Remove(plugin.Name);
        return new Content(records, InLoadOrderOrder(masters, loadOrder), links);
    }

    // ADR-0007 invariant 4: a dangling link is emittable, so compile writes the plugin and reports
    // it afterwards, answered by the files the game loads with the one just written among them.
    private List<CompileDiagnostic> LinkDiagnostics(
        Content content, PluginKey plugin, RegisteredCopy copy, LoadOrderSnapshot loadOrder,
        SourceRepository repository, string? atRef)
    {
        var answers = adapter.LinkTargets(
            loadOrder, copy, schemaReflector.GetSchemas(loadOrder.GameRelease), content.Links);
        ResolvedFormKey? Resolve(string formKey) =>
            answers.Targets.TryGetValue(formKey, out var entry) ? entry : null;

        // A file nothing could be read from answers nothing about the records in it, so a link into
        // it is unchecked with that reason, never broken (ADR-0019).
        var unread = answers.UnreadableFiles.ToDictionary(
            file => file.FileName, file => file.Reason, StringComparer.OrdinalIgnoreCase);
        string? WhyUnchecked(string formKey) =>
            PluginNameIn(formKey) is { } owner && unread.TryGetValue(owner, out var reason)
                ? $"{owner} could not be read, so this link was not checked: {reason}"
                : null;

        var diagnostics = answers.UnreadableFiles
            .Select(file => PluginDiagnostic(
                plugin,
                $"{file.FileName} is in the load order but could not be read, so no link into it was " +
                $"checked: {file.Reason}"))
            .ToList();
        foreach (var record in content.Records)
        {
            var errors = CheckErrors(
                record.Schema, record.Document.Text, Resolve, WhyUnchecked, loadOrder.GameRelease);
            if (errors.Count == 0) continue;

            // Only records with something to report pay for their path, which keeps a container's
            // subtree scan off the common path.
            var identity = new RecordIdentity(record.Document.FormKey, record.RecordType, record.EditorId);
            var relativePath = repository.RelativePathOf(plugin, identity, atRef) ?? string.Empty;
            diagnostics.AddRange(errors.Select(
                message => new CompileDiagnostic(record.Document.FormKey, relativePath, message)));
        }
        return diagnostics;
    }

    // A plugin-level problem is the header record's: it is the one source unit that stands for the
    // whole plugin, so the Problems entry lands on a file the author can open.
    private static CompileDiagnostic PluginDiagnostic(PluginKey plugin, string message) =>
        new(PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name)),
            SourceRepository.HeaderDocumentFor(plugin.Name),
            message);

    // The same fields the editor shows a CheckError on, from the same builder, so compile and the
    // record panel cannot hold two definitions of what is broken.
    private static List<string> CheckErrors(
        RecordTableSchema schema, string text, Func<string, ResolvedFormKey?> resolve,
        Func<string, string?> whyUnchecked, GameRelease release)
    {
        var errors = new List<string>();
        using var document = JsonDocument.Parse(text);
        var root = document.RootElement;
        foreach (var column in schema.RecordColumns)
        {
            var meta = column.ToFieldMetadata();
            // The collector's own gate: a column with no formKey leaf has nothing to check.
            if (!FormReferences.CarriesFormKeys(meta)) continue;

            var checkError = CheckErrorBuilder.Build(
                DocumentNodes.VariantFor(meta, root), DocumentNodes.At(root, column.PropertyName), resolve, release,
                whyUnchecked);
            if (checkError != null) errors.Add($"{meta.Name}: {checkError}");
        }
        return errors;
    }

    // A master the load order holds sorts by its slot; one it does not falls after every held
    // master, alphabetically among themselves, so the result is stable either way.
    private static IReadOnlyList<string> InLoadOrderOrder(HashSet<string> masters, LoadOrderSnapshot loadOrder)
    {
        if (masters.Count == 0) return [];

        var slots = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var copy in loadOrder.Copies)
        {
            if (copy.Slot is not { } slot) continue;
            if (!slots.TryGetValue(copy.Name, out var held) || slot < held) slots[copy.Name] = slot;
        }

        return [.. masters
            .OrderBy(m => slots.GetValueOrDefault(m, int.MaxValue))
            .ThenBy(m => m, StringComparer.OrdinalIgnoreCase)];
    }

    // The plugin half of a FormKey, which is how a reference names the master it needs. Mutagen's
    // own parser, not a split on the colon: a FormKey's spelling is its definition.
    private static string? PluginNameIn(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed) ? parsed.ModKey.FileName.String : null;

    // Whatever is wrong with the source, the remedy is re-Track (ADR-0006), so the catch is
    // deliberately unfiltered and the message uniform.
    private (CompiledTree? Tree, string? RefusalReason) DeserializeSource(
        IReadOnlyList<TreeFile> files, string pluginName, GameRelease release)
    {
        var read = adapter.ReadTreeAsync(files, codec, release).GetAwaiter().GetResult();
        if (read.Tree is { } tree) return (tree, null);

        logger.LogWarning(read.Error, "{Plugin} could not be read from its source", pluginName);
        return (null,
            $"{pluginName} could not be read from its source: {read.Diagnosis!.Describe()} " +
            "Re-Track to regenerate the source.");
    }

    // ADR-0006: the generated deserializer skips an unrecognized property or file without throwing,
    // so a successful parse proves nothing. The check is self-consistency in both directions: a
    // document the regeneration does not produce is content the parse dropped.

    // No live subrecord-inventory gate here, deliberately: that loss class arises only when Track
    // parses an external binary, never from Compile.
    private static string? RefuseIfSourceDoesNotRoundTrip(
        CompiledTree tree, string pluginName, IReadOnlyList<TreeFile> sourceFiles)
    {
        var regeneratedFiles = SourceRepository.PristineFilesOf(
            pluginName, tree.SerializeTreeAsync().GetAwaiter().GetResult());
        var headerDocument = SourceRepository.HeaderDocumentFor(pluginName);
        var read = sourceFiles.ToDictionary(file => file.RelativePath, file => file.Content, StringComparer.Ordinal);

        foreach (var file in regeneratedFiles)
        {
            if (read.TryGetValue(file.RelativePath, out var content)
                && content.AsSpan().SequenceEqual(file.Content))
            {
                continue;
            }

            var offender = file.RelativePath == headerDocument ? "the plugin header" : file.RelativePath;
            return $"{pluginName} does not round-trip through its own source: {offender} does not match " +
                "what the current codec would produce from it. Re-Track to regenerate the source.";
        }

        var regeneratedPaths = regeneratedFiles.Select(f => f.RelativePath).ToHashSet(StringComparer.Ordinal);
        var unproduced = read.Keys
            .Where(relativePath => !regeneratedPaths.Contains(relativePath))
            .Order(StringComparer.Ordinal)
            .FirstOrDefault();
        if (unproduced != null)
        {
            return $"{pluginName} does not round-trip through its own source: {unproduced} is in the source, " +
                "but the current codec produces no such file from it, so nothing it holds reaches the plugin " +
                "(a document left over from an earlier source layout, or a stray file). Re-Track to regenerate the source.";
        }

        return null;
    }
}
