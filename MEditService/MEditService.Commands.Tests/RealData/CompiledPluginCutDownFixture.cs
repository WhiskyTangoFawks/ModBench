using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.RealData;

/// <summary>The cut-down plugin as init leaves it, read and never written.</summary>
public sealed class CompiledPluginCutDownFixture : IDisposable
{
    public ScratchDirectory ModFolder { get; } = new("medit-init-roundtrip-");

    private readonly IReadOnlyList<SourceDocument> documents;

    public CompiledPluginCutDownFixture()
    {
        CutDownPluginFixture.CompiledPluginInto(ModFolder);
        documents = TreeDocuments.Of(TestAdapters.Source().Open(TestMod.Of(CutDownPluginFixture.Plugin, ModFolder), GameRelease.Fallout4).Require(), CutDownPluginFixture.Plugin);
    }

    public IReadOnlyList<SourceDocument> Documents() => documents;

    public Dictionary<string, byte[]> ReadSourceTree() => CutDownPluginFixture.ReadSourceTree(ModFolder);

    public void Dispose() => ModFolder.Dispose();
}
