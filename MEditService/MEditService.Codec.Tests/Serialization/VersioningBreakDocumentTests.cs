using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class VersioningBreakDocumentTests
{
    private static Fallout4Mod NewMod() => new(ModKey.FromFileName("Breaks.esp"), Fallout4Release.Fallout4);

    internal static Quest QuestWithAdapter(Fallout4Mod mod, QuestAdapter.VersioningBreaks versioning)
    {
        var quest = mod.Quests.AddNew("BreakQuest");
        var adapter = new QuestAdapter { Versioning = versioning };
        adapter.Scripts.Add(new ScriptEntry { Name = "QuestScript" });
        quest.VirtualMachineAdapter = adapter;
        return quest;
    }

    [Fact]
    public void AQuestAdapterReadFromBytesThatEndAtItsBreak_ReadsBackAsTheDocumentItsCodecWrote()
    {
        var mod = NewMod();
        QuestWithAdapter(mod, QuestAdapter.VersioningBreaks.Break0);
        using var scratch = new ScratchDirectory("medit-versioning-break-");
        var path = Path.Combine(scratch.Path, mod.ModKey.FileName);
        mod.WriteToBinary(path);
        using var overlay = Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4);

        var text = RecordTextCodec.SerializeToText(overlay.Quests.Single(), GameRelease.Fallout4);

        Assert.Equal(text, RecordTextCodec.RoundTrip(text, GameRelease.Fallout4, "qust"));
    }
}
