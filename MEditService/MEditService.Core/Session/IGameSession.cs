using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

public interface IGameSession : IDisposable
{
    string DataFolderPath { get; }

    /// <summary>#592 / ADR-0001: the MO2 instance root this session was loaded from — the working
    /// directory holding <c>ModOrganizer.ini</c>, <c>mods/</c> and <c>profiles/</c>. It is what the
    /// index file is keyed on (<see cref="Records.IndexFile"/>), because <c>origin</c> is a mod
    /// folder name and so is only unique within one instance. Null for a session with no instance to
    /// key a file by, which asks for an in-memory index.</summary>
    string? InstanceRoot { get; }

    GameRelease GameRelease { get; }
    IReadOnlyList<PluginMetadata> Plugins { get; }
    IReadOnlyList<PluginLoadFailure> LoadFailures { get; }
    string? FilterSql { get; set; }
    // #34 / ADR-0036: origin is required, not optional — a session can hold two copies of one
    // filename, so the filename alone no longer identifies which mod to return.
    IModGetter? GetMod(string pluginName, string origin);
    PluginMetadata AddPlugin(string filePath);
    PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex);
    bool RemoveUnlistedPlugin(string pluginName, string origin);
}
