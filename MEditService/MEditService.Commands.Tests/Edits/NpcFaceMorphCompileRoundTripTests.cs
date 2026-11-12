using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;

namespace MEditService.Commands.Tests.Edits;

public sealed class NpcFaceMorphCompileRoundTripTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public async Task AFaceMorphWhoseTailHoldsFloatEpsilonBits_CompilesToABinaryHoldingTheSameTail()
    {
        byte[] tail = [1, 0, 0, 0, 2, 0, 0, 0];
        var npc = new Npc(KeyOf(0x801), Fallout4Release.Fallout4)
        {
            EditorID = "Npc",
            FaceMorphs = [new NpcFaceMorph { Index = 7, Unknown = tail }],
        };
        _fixture.Seed(npc, "npc_");

        using var compiled = await _fixture.CompiledAsync(_fixture.Plugin);
        var morphs = compiled.Npcs.Single().FaceMorphs;
        Assert.NotNull(morphs);
        var morph = Assert.Single(morphs);
        Assert.Equal(tail, morph.Unknown.ToArray());
    }
}
