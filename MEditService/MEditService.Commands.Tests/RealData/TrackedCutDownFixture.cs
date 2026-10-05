using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.RealData;

/// <summary>The cut-down plugin as Track leaves it, read and never written.</summary>
public sealed class TrackedCutDownFixture : IDisposable
{
    public ScratchDirectory ModFolder { get; } = new("medit-track-roundtrip-");

    private readonly IReadOnlyList<SourceDocument> documents;

    public TrackedCutDownFixture()
    {
        CutDownPluginFixture.TrackedInto(ModFolder);
        documents = TreeDocuments.Of(SourceRepository.Open(TestMod.In(ModFolder), GameRelease.Fallout4).Require(), CutDownPluginFixture.Plugin);
    }

    public IReadOnlyList<SourceDocument> Documents() => documents;

    public Dictionary<string, byte[]> ReadSourceTree() => CutDownPluginFixture.ReadSourceTree(ModFolder);

    public void Dispose() => ModFolder.Dispose();
}
