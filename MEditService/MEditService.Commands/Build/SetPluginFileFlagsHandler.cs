using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Build;

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

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal SetPluginFileFlagsHandler(IPluginAdapter plugins) => _plugins = plugins;

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
            else refused.Add(new PluginFileFlagRefused(file.Path, PluginFileFlagRefusal.NotAPlugin, failure.Reason));
        }

        return new SetPluginFileFlagsResult(applied, refused);
    }
}
