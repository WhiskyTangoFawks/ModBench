using System.Text.Json.Serialization;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum PluginFileFlagRefusal
{
    None,

    /// <summary>The file could not be read or written as a plugin.</summary>
    NotAPlugin,

    /// <summary>A name is no load flag of the game.</summary>
    UnknownFlag,

    /// <summary>The plugin holds native FormIDs outside the range a light or medium flag limits it to.</summary>
    FormIdOutsideFlagLimit,
}

/// <summary>A plugin file whose flags were not set, by its path, and why.</summary>
public sealed record PluginFileFlagRefused(string Item, PluginFileFlagRefusal Refusal, string Message) : IItemRefused<PluginFileFlagRefusal>
{
    object IItemRefused<PluginFileFlagRefusal>.Item => Item;
}

/// <summary>A plugin file whose load flags were set, by its path, with the hash of what was written.</summary>
public sealed record PluginFileFlagsSet(string Path, string Hash);

/// <summary>A plugin file and the load flags to set or clear in it.</summary>
public sealed record PluginFileFlagsToSet(string Path, IReadOnlyDictionary<string, bool> Flags);

public sealed record SetPluginFileFlagsResult(IReadOnlyList<PluginFileFlagsSet> Applied, IReadOnlyList<PluginFileFlagRefused> Refused)
    : ISelectionAnswer<PluginFileFlagRefused>;

/// <summary>Restore's setting of the load flags a manifest records for a plugin it wrote from its package (ADR-0022).</summary>
public sealed class SetPluginFileFlagsHandler
{
    private readonly IPluginAdapter _plugins;
    private readonly LoadOrderHolder _loadOrder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal SetPluginFileFlagsHandler(IPluginAdapter plugins, LoadOrderHolder loadOrder) => (_plugins, _loadOrder) = (plugins, loadOrder);

    public SetPluginFileFlagsResult Set(IReadOnlyList<PluginFileFlagsToSet> files, GameRelease gameRelease)
    {
        var known = GameCodecs.For(gameRelease).LoadFlags;
        List<PluginFileFlagsSet> applied = [];
        List<PluginFileFlagRefused> refused = [];
        foreach (var file in files)
        {
            if (file.Flags.Keys.FirstOrDefault(name => !known.ContainsKey(name)) is { } unknown)
                refused.Add(new PluginFileFlagRefused(file.Path, PluginFileFlagRefusal.UnknownFlag, $"'{unknown}' is no load flag of {gameRelease}"));
            else if (_plugins.SetLoadFlags(file.Path, file.Flags, gameRelease).Holds(out var hash, out var failure))
                applied.Add(new PluginFileFlagsSet(file.Path, hash));
            else refused.Add(new PluginFileFlagRefused(file.Path, RefusalOf(failure), failure.Reason));
        }

        if (PluginsWritten(applied.Select(set => set.Path)) is { Count: > 0 } written) _loadOrder.SourceWritten(written);
        return new SetPluginFileFlagsResult(applied, refused);
    }

    // The record index holds nothing of a file no plugin of the load order is, so a write to one has nothing to be read.
    private List<PluginChange> PluginsWritten(IEnumerable<string> paths)
    {
        var held = _loadOrder.Current.Plugins;
        return [.. paths
            .Select(path => held.FirstOrDefault(plugin => string.Equals(plugin.Path, path, StringComparison.OrdinalIgnoreCase)))
            .OfType<RegisteredPlugin>()
            .Select(plugin => new PluginChange(plugin.Key, null))];
    }

    private static PluginFileFlagRefusal RefusalOf(PluginFailure failure) =>
        failure is PluginFailure.FormIdOutsideFlagLimit ? PluginFileFlagRefusal.FormIdOutsideFlagLimit : PluginFileFlagRefusal.NotAPlugin;
}
