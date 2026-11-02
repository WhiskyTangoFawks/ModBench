using System.Text.Json.Serialization;
using MEditService.Commands.Edits;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Build;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum PluginFileFlagRefusal
{
    None,

    /// <summary>The file could not be read or written as a plugin.</summary>
    NotAPlugin,

    /// <summary>A name is no load flag of the game.</summary>
    UnknownFlag,
}

/// <summary>A plugin file not read or written, by its path, and why.</summary>
public sealed record PluginFileFlagRefused(string Item, PluginFileFlagRefusal Refusal, string Message) : IItemRefused<PluginFileFlagRefusal>
{
    object IItemRefused<PluginFileFlagRefusal>.Item => Item;
}

/// <summary>The variants of a plugin file by its path.</summary>
public sealed record PluginFileFlagVariants(string Path, IReadOnlyList<FlagVariant> Variants);

public sealed record PluginFileFlagVariantsResult(IReadOnlyList<PluginFileFlagVariants> Applied, IReadOnlyList<PluginFileFlagRefused> Refused)
    : ISelectionAnswer<PluginFileFlagRefused>;

/// <summary>What a manifest records of a plugin's load flags (ADR-0022): each plugin file's bytes with its load flags
/// flipped, so a caller finds the flags that make a package's copy the file.</summary>
public sealed class PluginFileFlagVariantsHandler
{
    private readonly IPluginAdapter _plugins;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal PluginFileFlagVariantsHandler(IPluginAdapter plugins) => _plugins = plugins;

    public PluginFileFlagVariantsResult VariantsOf(IReadOnlyList<string> paths, GameRelease gameRelease)
    {
        List<PluginFileFlagVariants> applied = [];
        List<PluginFileFlagRefused> refused = [];
        foreach (var path in paths)
        {
            if (_plugins.FlagVariantsOf(path, gameRelease).Holds(out var variants, out var failure))
                applied.Add(new PluginFileFlagVariants(path, variants));
            else refused.Add(new PluginFileFlagRefused(path, PluginFileFlagRefusal.NotAPlugin, failure.Reason));
        }

        return new PluginFileFlagVariantsResult(applied, refused);
    }
}
