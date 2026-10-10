using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>One session per mod folder over a request's unsaved texts, so an item of a selection sees what the
/// ones before it changed there.</summary>
internal sealed class WriteSessions(ISourceAdapter source, IReadOnlyList<DocumentChange> unsaved)
{
    private readonly Dictionary<string, IWriteSession> _byFolder = new(StringComparer.Ordinal);

    internal IWriteSession Over(PluginProvider.FromMod mod, GameRelease release)
    {
        if (!_byFolder.TryGetValue(mod.Folder, out var session))
            _byFolder[mod.Folder] = session = source.WriteSessionOver(mod, release, unsaved);
        return session;
    }
}
