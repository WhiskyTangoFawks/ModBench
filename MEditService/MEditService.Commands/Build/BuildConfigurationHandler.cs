using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>The build configuration's half of rename and of exclude or include: Modbench writes the mod folder, and
/// this the configuration, so the folder already equals the next build's output (mods.md, A source mod, story 2).</summary>
public sealed class BuildConfigurationHandler
{
    private readonly ISourceAdapter _source;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal BuildConfigurationHandler(ISourceAdapter source) => _source = source;

    public BuildConfigurationResult Change(string sourceFolder, BuildConfigurationChange change) =>
        _source.ChangeBuildConfiguration(sourceFolder, change) switch
        {
            null => new BuildConfigurationResult(),
            SourceFailure.Unreadable unreadable => new BuildConfigurationResult(BuildConfigurationRefusal.Unreadable, unreadable.Reason),
            { } failure => new BuildConfigurationResult(
                BuildConfigurationRefusal.WriteFailed, $"The build configuration in '{sourceFolder}' could not be written: {failure.Reason}"),
        };
}

/// <summary>Whether the configuration changed, or why it was left as it was.</summary>
public sealed record BuildConfigurationResult(BuildConfigurationRefusal? Refusal = null, string? Message = null);

/// <summary>Why a change to a build configuration wrote nothing (ADR-0019).</summary>
public enum BuildConfigurationRefusal
{
    /// <summary>The source folder holds no build configuration, or one that cannot be read.</summary>
    Unreadable,

    /// <summary>The file system refused the write.</summary>
    WriteFailed,
}
