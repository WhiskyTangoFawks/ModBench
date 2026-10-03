using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.RealData;

/// <summary>The cut-down plugin as Track leaves it, read and never written.</summary>
public sealed class TrackedCutDownFixture : IDisposable
{
    public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-track-roundtrip-").FullName;

    public TrackedCutDownFixture() => CutDownPluginFixture.TrackedInto(ModFolder);

    public string SourceRoot => CutDownPluginFixture.SourceRootIn(ModFolder);

    public Dictionary<string, byte[]> ReadSourceTree() => CutDownPluginFixture.ReadSourceTree(ModFolder);

    public void Dispose() => TrackedTemplates.TryDelete(ModFolder);
}
