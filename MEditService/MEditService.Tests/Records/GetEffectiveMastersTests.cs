using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>Effective masters are derived from content, never the declared header list. The fixture
/// discriminates: Patch.esp declares three masters but its content requires two, so header-declared
/// semantics would wrongly include Unused.esm.</summary>
public sealed class GetEffectiveMastersTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);
    private static readonly string[] PluginOrder = ["Base.esm", "Ref.esm", "Unused.esm", "Patch.esp"];

    private readonly PluginFixtureData _fixture;

    public GetEffectiveMastersTests()
    {
        FormKey baseNpcFk = default, refNpcFk = default;
        _fixture = new PluginFixtureBuilder("effective-masters")
            .WithPlugin("Base.esm", mod => baseNpcFk = mod.Npcs.AddNew("BaseNPC").FormKey)
            .WithPlugin("Ref.esm", mod => refNpcFk = mod.Npcs.AddNew("RefNPC").FormKey)
            .WithPlugin("Unused.esm", mod => mod.Npcs.AddNew("UnusedNPC"))
            .WithPlugin("Patch.esp", (mod, built) =>
            {
                // Over-declares all three — the header alone cannot tell "required" from "not".
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Ref.esm") });
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Unused.esm") });

                // Requires Base.esm via an override (a non-native FormKey this plugin carries).
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.Npcs.Set(basePlugin.Npcs.First(n => n.FormKey == baseNpcFk).DeepCopy());

                // Requires Ref.esm via an outward reference only — no override of anything in Ref.esm.
                var patchNpc = mod.Npcs.AddNew("PatchNPC");
                patchNpc.Race.SetTo(refNpcFk);

                // Unused.esm: declared as a master, but nothing here references or overrides it —
                // must be excluded from the derived result.
            },
            // Mutagen's writer recomputes the header's masters from live content by default, which
            // is the derived-not-declared rule under test and would prune the deliberately-unused
            // reference above.
            writeParams: new BinaryWriteParameters { MastersListContent = MastersListContentOption.NoCheck })
            .Build();
    }

    public void Dispose() => _fixture.Dispose();

    private DuckDbRecordIndex LoadedRepository(out IReadOnlyList<string> patchDeclaredMasters)
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);

        IReadOnlyList<string>? declared = null;
        for (var i = 0; i < PluginOrder.Length; i++)
        {
            var name = PluginOrder[i];
            var path = new ModPath(ModKey.FromFileName(name), Path.Combine(_fixture.DataFolder, name));
            var mod = Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4);
            repo.Index(mod, Registration.Participating(i), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
            if (name == "Patch.esp")
                declared = [.. mod.MasterReferences.Select(m => m.Master.FileName.ToString())];
        }
        repo.UpdateWinners();

        patchDeclaredMasters = declared!;
        return repo;
    }

    [Fact]
    public void GetEffectiveMasters_ExcludesADeclaredButUnreferencedMaster_InLoadOrder()
    {
        using var repo = LoadedRepository(out _);

        var masters = repo.At(RecordRef.Effective).GetEffectiveMasters(new PluginKey("Patch.esp", "Data"));

        Assert.Equal(["Base.esm", "Ref.esm"], masters);
    }

    [Fact]
    public void GetEffectiveMasters_DiffersFromTheDeclaredHeaderList()
    {
        using var repo = LoadedRepository(out var declaredMasters);

        var derived = repo.At(RecordRef.Effective).GetEffectiveMasters(new PluginKey("Patch.esp", "Data"));

        Assert.Equal(["Base.esm", "Ref.esm", "Unused.esm"], declaredMasters);
        Assert.NotEqual(declaredMasters, derived);
        Assert.DoesNotContain("Unused.esm", derived);
    }

    [Fact]
    public void GetEffectiveMasters_PluginWithNoDependencies_ReturnsEmpty()
    {
        using var repo = LoadedRepository(out _);

        Assert.Empty(repo.At(RecordRef.Effective).GetEffectiveMasters(new PluginKey("Base.esm", "Data")));
    }
}
