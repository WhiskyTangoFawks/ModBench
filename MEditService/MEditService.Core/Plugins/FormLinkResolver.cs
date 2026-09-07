using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Plugins;

/// <summary>Where a FormLink points, without the Index (ADR-0046 invariant 7): the copy the load
/// order loads answers, from its working tree when tracked and its own file when not. One per
/// request, not thread-safe.</summary>
public sealed class FormLinkResolver(LoadOrder loadOrder, IModImporter importer, SchemaReflector schemaReflector)
    : IDisposable
{
    // Open until this resolver is disposed, so its lifetime is how long an answer may be stale. A
    // failed open is remembered too, or it is retried once per link in the record being edited.
    private readonly Dictionary<PluginKey, (ILoadedMod Mod, ILinkCache Cache)?> _opened = [];

    /// <summary>The record type and EditorID <paramref name="formKey"/> names, or null when the
    /// load order holds nothing that names it: an unregistered plugin, a copy the game does not
    /// load, or a record neither tree nor file carries.</summary>
    public RecordLookupEntry? Resolve(string formKey)
    {
        // A malformed FormKey is an editor's raw input, not a broken link: it resolves to nothing and
        // throws nothing.
        if (!FormKey.TryFactory(formKey, out var parsed)) return null;
        if (loadOrder.WinningCopy(parsed.ModKey.FileName) is not { } copy) return null;
        // ADR-0044: a disabled, losing or unlisted copy is registered but not loaded, so nothing it
        // holds is what this FormKey points at.
        if (!copy.Registration.Participates) return null;

        // A tracked copy's tree is its whole answer: a record the tree does not carry is one the
        // author deleted, and falling back to the compiled file would resurrect it.
        return ModFolders.TrackedOf(loadOrder, copy.Key) is { } modFolder
            ? FromWorkingTree(modFolder, copy.Name, formKey)
            : FromPluginFile(copy, parsed);
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

    private RecordLookupEntry? FromWorkingTree(string modFolder, string pluginFileName, string formKey) =>
        SourceIdentities.Of(modFolder, pluginFileName, formKey, loadOrder.GameRelease) is { } identity
            ? new RecordLookupEntry(identity.RecordType, identity.EditorId)
            : null;

    private RecordLookupEntry? FromPluginFile(RegisteredCopy copy, FormKey formKey)
    {
        if (Opened(copy) is not { } opened || !opened.Cache.TryResolve<IMajorRecordGetter>(formKey, out var record)) return null;

        return new RecordLookupEntry(
            SourceRecordType.Resolve(record, schemaReflector.GetSchemas(loadOrder.GameRelease)), record.EditorID);
    }

    private (ILoadedMod Mod, ILinkCache Cache)? Opened(RegisteredCopy copy)
    {
        if (_opened.TryGetValue(copy.Key, out var already)) return already;

        (ILoadedMod, ILinkCache)? opened;
        try
        {
            var mod = importer.Import(new ModPath(copy.Path), loadOrder.GameRelease);
            opened = (mod, mod.Getter.ToUntypedImmutableLinkCache());
        }
        // Every failure, as HeldPlugins opens a copy: Mutagen throws its own hierarchy for a
        // malformed file, and MO2 can replace one the load order still names. Unreadable holds
        // no answer, which is what unresolved says.
        catch (Exception)
        {
            opened = null;
        }

        _opened[copy.Key] = opened;
        return opened;
    }
}
