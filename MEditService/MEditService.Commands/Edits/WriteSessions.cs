using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>One session per mod folder over a request's unsaved texts, so an item of a selection sees what the
/// ones before it changed there.</summary>
internal sealed class WriteSessions(IReadOnlyList<DocumentChange> unsaved)
{
    private readonly Dictionary<string, WriteSession> _byFolder = new(StringComparer.Ordinal);

    internal WriteSession Over(PluginProvider.FromMod mod, GameRelease release)
    {
        if (!_byFolder.TryGetValue(mod.Folder, out var session))
            _byFolder[mod.Folder] = session = WriteSession.Over(mod, release, unsaved);
        return session;
    }
}
