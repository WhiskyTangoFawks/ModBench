using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Plugins;

/// <summary>The plugin copies Editing currently holds, each with its registration (ADR-0044).
/// A mirror of Mod Management's snapshot, kept true by reconcile — nothing is loaded or exited.</summary>
public interface ILoadOrder : IDisposable
{
    string DataFolderPath { get; }

    /// <summary>ADR-0001: the MO2 instance root the index file is keyed on, because <c>origin</c>
    /// is a mod folder name and so is unique only within one instance. Null asks for an in-memory
    /// index.</summary>
    string? InstanceRoot { get; }

    GameRelease GameRelease { get; }
    IReadOnlyList<PluginMetadata> Plugins { get; }
    IReadOnlyList<PluginLoadFailure> LoadFailures { get; }
    string? FilterSql { get; set; }
    // ADR-0036: origin is required, not optional — the load order can hold two copies of one
    // filename, so the filename alone does not identify which mod to return.
    IModGetter? GetMod(string pluginName, string origin);
}
