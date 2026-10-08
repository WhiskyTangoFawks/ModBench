using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

internal sealed record LinkCheckScope(
    PluginAddress Address, RegisteredPlugin Registered, LoadOrderSnapshot LoadOrder, SourceRepository Repository);

internal sealed record SourceRecord(
    string RecordType, RecordTableSchema Schema, PluginDocument Document, string? EditorId);

/// <summary>The link diagnostics of a compiled plugin (ADR-0007).</summary>
internal sealed class CompileLinks(IPluginAdapter adapter, SchemaReflector schemaReflector, ILogger logger)
{
    // The binary is written and the snapshot parked, so the report is the only thing left to go
    // wrong: it becomes a diagnostic saying so, never a refusal of a compile that happened.
    internal List<CompileDiagnostic> Report(
        LinkCheckScope compiled, IReadOnlyList<SourceRecord> records, IReadOnlyCollection<string> links)
    {
        var (plugin, _, _, repository) = compiled;
        try
        {
            return LinkDiagnostics(compiled, records, links);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogWarning(ex, "{Plugin} compiled, but its link check did not run", plugin.Name);
            return [PluginDiagnostic(
                plugin, repository, $"{plugin.Name} compiled, but its links could not be checked: {ex.Message}")];
        }
    }

    // A dangling link is a diagnostic, not a refusal (ADR-0007), answered after the write by the
    // files the game loads, the one just written among them.
    private List<CompileDiagnostic> LinkDiagnostics(
        LinkCheckScope compiled, IReadOnlyList<SourceRecord> records, IReadOnlyCollection<string> links)
    {
        var (plugin, registered, loadOrder, repository) = compiled;
        var answers = adapter.LinkTargets(
            loadOrder, registered, schemaReflector.GetSchemas(loadOrder.GameRelease), links);
        ResolvedFormKey? Resolve(string formKey) =>
            answers.Targets.TryGetValue(formKey, out var entry) ? entry : null;

        // A file nothing could be read from answers nothing about the records in it, so a link into
        // it is unchecked with that reason, never broken (ADR-0019).
        var unread = answers.UnreadableFiles.ToDictionary(
            file => file.FileName, file => file.Reason, StringComparer.OrdinalIgnoreCase);
        string? WhyUnchecked(string formKey) =>
            RequiredMasters.PluginNameIn(formKey) is { } owner && unread.TryGetValue(owner, out var reason)
                ? $"{owner} could not be read, so this link was not checked: {reason}"
                : null;

        var diagnostics = answers.UnreadableFiles
            .Select(file => PluginDiagnostic(
                plugin, repository,
                $"{file.FileName} is in the load order but could not be read, so no link into it was " +
                $"checked: {file.Reason}"))
            .ToList();
        foreach (var record in records)
        {
            var errors = CheckErrors(
                record.Schema, record.Document.Text, Resolve, WhyUnchecked, loadOrder.GameRelease);
            if (errors.Count == 0) continue;

            // Only records with something to report pay for their path, which keeps a container's
            // subtree scan off the common path.
            var identity = new RecordIdentity(record.Document.FormKey, record.RecordType, record.EditorId);
            var relativePath = repository.RelativePathOf(plugin, identity)
                ?? throw new InvalidOperationException($"Expected a document to hold {identity.FormKey}.");
            diagnostics.AddRange(errors.Select(
                message => new CompileDiagnostic(record.Document.FormKey, relativePath, message)));
        }
        return diagnostics;
    }

    // A plugin-level problem is the header record's: it is the one source unit that stands for the
    // whole plugin, so the Problems entry lands on a file the author can open.
    internal static CompileDiagnostic PluginDiagnostic(PluginAddress plugin, SourceRepository repository, string message)
    {
        var header = new RecordIdentity(
            PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name)), PluginHeader.RecordType, null);
        var path = repository.RelativePathOf(plugin, header)
            ?? throw new InvalidOperationException($"Expected {plugin.Name}'s header to have a document.");
        return new(header.FormKey, path, message);
    }

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
}
