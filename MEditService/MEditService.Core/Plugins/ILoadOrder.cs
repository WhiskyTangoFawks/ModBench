using Mutagen.Bethesda;

namespace MEditService.Core.Plugins;

/// <summary>The plugin copies Editing currently holds, each with its registration (ADR-0044): the
/// live view of Mod Management's snapshot, kept true by reconcile — nothing is loaded or exited.
/// Opening a copy is the Plugin adapter's work.</summary>
public interface ILoadOrder : IDisposable
{
    string DataFolderPath { get; }

    /// <summary>ADR-0001: the MO2 instance root the index file is keyed on, because <c>origin</c>
    /// is a mod folder name and so is unique only within one instance. Null asks for an in-memory
    /// index.</summary>
    string? InstanceRoot { get; }

    GameRelease GameRelease { get; }
    IReadOnlyList<PluginMetadata> Plugins { get; }
}
