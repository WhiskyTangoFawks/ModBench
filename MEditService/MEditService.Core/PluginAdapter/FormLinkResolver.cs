using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.PluginAdapter;

/// <summary>Where a FormLink points, without the Index (ADR-0015 invariant 5): the copy the load
/// order loads answers, from its working tree when tracked and its own file when not. One per
/// request, not thread-safe.</summary>
public sealed class FormLinkResolver(
    LoadOrder loadOrder, IPluginAdapter adapter, SchemaReflector schemaReflector,
    ILogger<FormLinkResolver>? logger = null) : IDisposable
{
    private readonly ILogger _logger = logger ?? NullLogger<FormLinkResolver>.Instance;

    // Open until this resolver is disposed, so its lifetime is how long an answer may be stale. A
    // failed open is remembered too, or it is retried once per link in the record being edited.
    private readonly Dictionary<PluginKey, (ILoadedMod Mod, ILinkCache Cache)?> _opened = [];

    // One repository per tracked mod folder, kept for this resolver's life so its listing and
    // owner-map memos answer every link in one record from one scan of the tree.
    private readonly Dictionary<string, SourceRepository> _repositories = new(StringComparer.Ordinal);

    /// <summary>The record type and EditorID <paramref name="formKey"/> names, or null when the
    /// load order holds nothing that names it: an unregistered plugin, a copy the game does not
    /// load, or a record neither tree nor file carries.</summary>
    public RecordLookupEntry? Resolve(string formKey)
    {
        // A malformed FormKey is an editor's raw input, not a broken link: it resolves to nothing and
        // throws nothing.
        if (!FormKey.TryFactory(formKey, out var parsed)) return null;
        if (loadOrder.WinningCopy(parsed.ModKey.FileName) is not { } copy) return null;
        // ADR-0013: a disabled, losing or unlisted copy is registered but not loaded, so nothing it
        // holds is what this FormKey points at.
        if (!copy.Registration.Participates) return null;

        // Spelled as the registered copy spells it, once, here: the caller's text is an editor's raw
        // input, and every reader below compares against the codec's own canonical spelling.
        var canonical = new FormKey(ModKey.FromFileName(copy.Name), parsed.ID);

        // A tracked copy's tree is its whole answer: a record the tree does not carry is one the
        // author deleted, and falling back to the compiled file would resurrect it.
        return TrackedTree(copy) is { } repository
            ? FromWorkingTree(repository, copy.Key, canonical)
            : FromPluginFile(copy, canonical);
    }

    public void Dispose()
    {
        foreach (var opened in _opened.Values)
        {
            opened?.Cache.Dispose();
            opened?.Mod.Dispose();
        }
        _opened.Clear();
    }

    // Null when the copy has no tracked mod folder, which is the one condition under which it has
    // source text at all.
    private SourceRepository? TrackedTree(RegisteredCopy copy)
    {
        if (ModFolders.Of(loadOrder, copy.Key) is not { } modFolder) return null;
        if (_repositories.TryGetValue(modFolder, out var already)) return already;

        var opened = SourceRepository.Open(modFolder, loadOrder.GameRelease);
        if (opened != null) _repositories[modFolder] = opened;
        return opened;
    }

    private RecordLookupEntry? FromWorkingTree(SourceRepository repository, PluginKey plugin, FormKey formKey)
    {
        try
        {
            return repository.IdentityOf(plugin, formKey.ToString(), schemaReflector.GetSchemas(loadOrder.GameRelease))
                is { } identity
                ? new RecordLookupEntry(identity.RecordType, identity.EditorId)
                : null;
        }
        // Naming a record means reading the document carrying it, and a corrupt one is the target's
        // defect, not the edited record's: unresolved here, so the edit refuses the link.
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            _logger.LogWarning(
                ex, "Could not read {Plugin}'s tree for {FormKey}; links into it read as unresolved",
                plugin.Name, formKey);
            return null;
        }
    }

    private RecordLookupEntry? FromPluginFile(RegisteredCopy copy, FormKey formKey)
    {
        if (Opened(copy) is not { } opened || !opened.Cache.TryResolve<IMajorRecordGetter>(formKey, out var record)) return null;

        return new RecordLookupEntry(
            RecordTableName.Of(record, schemaReflector.GetSchemas(loadOrder.GameRelease)), record.EditorID);
    }

    private (ILoadedMod Mod, ILinkCache Cache)? Opened(RegisteredCopy copy)
    {
        if (_opened.TryGetValue(copy.Key, out var already)) return already;

        (ILoadedMod, ILinkCache)? opened;
        ILoadedMod? mod = null;
        try
        {
            mod = adapter.OpenForRead(new ModPath(copy.Path), loadOrder.GameRelease);
            opened = (mod, mod.Getter.ToUntypedImmutableLinkCache());
        }
        // Every failure, as HeldPlugins opens a copy: Mutagen throws its own hierarchy for a
        // malformed file, and MO2 can replace one the load order still names. Disposed here, since
        // only a stored pair is disposed later.
        catch (Exception ex)
        {
            mod?.Dispose();
            _logger.LogWarning(
                ex, "Failed to open plugin {FileName} ({Origin}); links into it cannot be resolved",
                copy.Name, copy.Origin);
            opened = null;
        }

        _opened[copy.Key] = opened;
        return opened;
    }
}
