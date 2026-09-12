using MEditService.Commands.Edits;
using MEditService.PluginAdapter;
using MEditService.LoadOrder;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.SourceRepo;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands;

/// <summary>Keep's handler (ADR-0014 invariant 3): every plugin's binary lands as
/// working-tree dirt, and every changed tracked file stages as-is. A collision on either
/// refuses the whole mod.</summary>
public sealed class KeepExternalChangeHandler
{
    private readonly WriteTargets _targets;
    private readonly IPluginAdapter _adapter;
    private readonly SchemaReflector _reflector;
    private readonly ILogger<KeepExternalChangeHandler> _logger;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal KeepExternalChangeHandler(
        WriteTargets targets, IPluginAdapter adapter, SchemaReflector reflector,
        ILogger<KeepExternalChangeHandler> logger) =>
        (_targets, _adapter, _reflector, _logger) = (targets, adapter, reflector, logger);

    public ExternalChangeLandResult Keep(string modFolder, IReadOnlyList<RegisteredCopy> plugins, GameRelease gameRelease)
    {
        var repository = SourceRepository.Open(modFolder, gameRelease)
            ?? throw new InvalidOperationException($"'{modFolder}' is not tracked, so it has no source to land on.");
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var schemas = _reflector.GetSchemas(gameRelease);

        var touchedByPlugin = new Dictionary<string, List<TouchedRecord>>(StringComparer.OrdinalIgnoreCase);
        foreach (var plugin in plugins)
            touchedByPlugin[plugin.Name] = TouchedRecordsFor(repository, new PluginKey(plugin.Name, plugin.Origin), plugin.Path, gameRelease, codec, schemas);

        var trackedFileChanges = SourceRepository.ChangedTrackedFilesOutsideSource(modFolder);
        var stagedAlready = trackedFileChanges.Where(c => c.StagedAlready).ToList();

        var colliding = touchedByPlugin.Values.SelectMany(t => t)
            .Where(t => !string.Equals(t.CurrentText, t.BaselineText, StringComparison.Ordinal)
                     && !string.Equals(t.CurrentText, t.IncomingText, StringComparison.Ordinal))
            .ToList();
        if (colliding.Count > 0 || stagedAlready.Count > 0)
        {
            return ExternalChangeLandResult.Refused(CollisionMessage(plugins, colliding, stagedAlready));
        }

        var landed = new List<string>();
        foreach (var plugin in plugins)
        {
            var pluginKey = new PluginKey(plugin.Name, plugin.Origin);
            foreach (var t in touchedByPlugin[plugin.Name])
            {
                repository.Put(pluginKey, new SourceDocument(t.FormKey, t.At.RecordType, t.At.EditorId, t.IncomingText));

                // A flat record's leaf name carries its EditorID, so an external rename moves its file
                // and leaves no duplicate behind; a container's directory keeps the name the tree gave it.
                if (t.Renameable) _targets.RenameTo(repository, pluginKey, t.At, t.IncomingEditorId);

                landed.Add(t.FormKey);
            }

            // The working tree now corresponds to this binary — atRef: null snapshots it as it stands,
            // as Save & Compile parks.
            var binarySha256 = PluginBinaryHash.TrailerFormOfFile(plugin.Path);
            SourceRepository.ParkCompileSnapshot(modFolder, plugin.Name, atRef: null, binarySha256);
        }

        // Index matches the working tree for every changed tracked file, so the same bytes cannot
        // re-raise the question next load.
        SourceRepository.StageTrackedFileChanges(modFolder, trackedFileChanges);
        ExternalChangeDeferral.Clear(modFolder);

        return ExternalChangeLandResult.Success(landed);
    }

    // The mod's own name travels on RegisteredCopy.Origin already (ADR-0009): every copy in
    // plugins shares it, so nothing here re-derives a name from the folder path.
    private static string CollisionMessage(
        IReadOnlyList<RegisteredCopy> plugins, List<TouchedRecord> colliding, List<TrackedFileChange> stagedAlready)
    {
        var parts = new List<string>();
        if (colliding.Count > 0)
            parts.Add($"record(s) the external change also touched — {string.Join(", ", colliding.Select(c => c.FormKey))}");
        if (stagedAlready.Count > 0)
            parts.Add($"tracked file(s) already dirty in the index — {string.Join(", ", stagedAlready.Select(c => c.RelativePath))}");

        return $"{plugins[0].Origin} has uncommitted working-tree changes on " +
            $"{string.Join(" and ", parts)}. Commit or revert them, then answer the external-change question again.";
    }

    // Keyed by the record, not its path: an external EditorID change moves a record's file. First
    // document wins a FormKey two claim — Compile refuses such a tree; refusing Keep over it too
    // would help nobody.
    private List<TouchedRecord> TouchedRecordsFor(
        SourceRepository repository, PluginKey plugin, string pluginPath, GameRelease gameRelease,
        RecordTextCodec codec, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var pluginName = plugin.Name;
        var baselineByFormKey = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var document in repository.ReadAll(plugin, SourceRepository.LastCompileRef(pluginName)))
            baselineByFormKey.TryAdd(document.FormKey, document.Body);

        // Keep only runs against a tracked plugin, so the mod-folder-only strings overload applies.
        var touched = new List<TouchedRecord>();
        foreach (var (incoming, incomingText) in _adapter.RecordDocumentsOf(
                     new ModPath(ModKey.FromFileName(pluginName), pluginPath), gameRelease,
                     PluginStrings.In(repository.ModFolder), codec, schemas))
        {
            var formKey = incoming.FormKey;
            var baselineText = baselineByFormKey.GetValueOrDefault(formKey);

            // The external change never touched this record, so nothing about it is this gesture's.
            if (string.Equals(incomingText, baselineText, StringComparison.Ordinal)) continue;

            var recordType = incoming.RecordType;
            var held = repository.IdentityOf(plugin, formKey, schemas);

            if (held is { } identity && repository.UnitHolding(plugin, identity) is { IsEmbedded: true } unit)
            {
                // Inlined in its owner's document, and the owner's own pass serializes this child's
                // current value as part of the owner's whole text.
                if (_logger.IsEnabled(LogLevel.Trace))
                {
                    _logger.LogTrace(
                        "Deferring {FormKey} ({RecordType}) in {Plugin} to its owner {OwnerFormKey}'s own pass — " +
                        "it is embedded, not its own source unit",
                        formKey, recordType, pluginName, unit.OwnerFormKey);
                }
                continue;
            }

            // A flat record's own leaf is computed, so a brand-new one lands; a container's is not,
            // and minting one needs the layout grammar this method lacks.
            var renameable = RecordTypeDispatch.For(gameRelease).FolderNameFor(recordType) is not null;
            if (held is null && !renameable)
            {
                if (_logger.IsEnabled(LogLevel.Debug))
                {
                    _logger.LogDebug(
                        "Skipping {FormKey} ({RecordType}) in {Plugin}: no existing source unit anywhere in " +
                        "the tree — landing a brand-new container isn't supported yet",
                        formKey, recordType, pluginName);
                }
                continue;
            }

            // An external EditorID change moves a flat record's file, so what the tree holds is asked
            // by FormKey: the collision check reads the real current text, and the leaf moves after.
            var at = held ?? incoming;
            touched.Add(new TouchedRecord(
                formKey, at, renameable, incoming.EditorId, incomingText,
                held is { } current ? repository.Get(plugin, current)?.Body : null,
                baselineText));
        }

        return touched;
    }

    // At is where the tree holds the record now; IncomingEditorId is what the binary calls it, which
    // is the leaf name a flat record moves to.
    private sealed record TouchedRecord(
        string FormKey, RecordIdentity At, bool Renameable, string? IncomingEditorId, string IncomingText,
        string? CurrentText, string? BaselineText);
}
