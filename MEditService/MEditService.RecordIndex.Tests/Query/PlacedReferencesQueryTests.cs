using System.Text.RegularExpressions;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class PlacedReferencesQueryTests : IDisposable
{
    private static readonly PluginAddress Compiled = new("Compiled.esp", "CompiledMod");
    private static readonly PluginAddress Rendered = new("Rendered.esp", "RenderedMod");

    private readonly ScatteredFixtureData _fixture;
    private readonly string _target;
    private readonly string _npc;
    private readonly string _topic;
    private readonly string _renderedNpc;

    public PlacedReferencesQueryTests()
    {
        FormKey target = default, npc = default, topic = default, renderedNpc = default;
        _fixture = new PluginFixtureBuilder("placed-references")
            .WithPlugin(Compiled.Name, mod =>
            {
                target = mod.Keywords.AddNew("Target").FormKey;
                var referrer = mod.Npcs.AddNew("Referrer");
                referrer.Keywords = [new FormLink<IKeywordGetter>(target), new FormLink<IKeywordGetter>(target)];
                npc = referrer.FormKey;
                var quest = mod.Quests.AddNew("Owner");
                var inside = new DialogTopic(mod) { EditorID = "Inside" };
                inside.Keyword.SetTo(target);
                quest.DialogTopics.Add(inside);
                topic = inside.FormKey;
            }, origin: Compiled.Origin)
            .WithPlugin(Rendered.Name, (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = built[0].ModKey });
                var referrer = mod.Npcs.AddNew("RenderedReferrer");
                referrer.Keywords = [new FormLink<IKeywordGetter>(target)];
                renderedNpc = referrer.FormKey;
            }, origin: Rendered.Origin)
            .BuildScattered();
        SourceMods.Init(_fixture.Plugins.Single(plugin => plugin.Name == Compiled.Name));
        (_target, _npc, _topic, _renderedNpc) = (target.ToString(), npc.ToString(), topic.ToString(), renderedNpc.ToString());
    }

    public void Dispose() => _fixture.Dispose();

    private static PlacedCopy CopyOf(PlacedReferences placed, string formKey) =>
        Assert.Single(placed.Copies, copy => copy.FormKey == formKey);

    private static readonly Regex VSCodeLineEnd = new("\r\n|\r|\n");

    private static string TextAt(string text, SourceRange range)
    {
        Assert.Equal(range.Start.Line, range.End.Line);
        return VSCodeLineEnd.Split(text)[range.Start.Line][range.Start.Character..range.End.Character];
    }

    private void AssertEachRangeIsTheTarget(string text, PlacedCopy copy) =>
        Assert.All(copy.Ranges, range => Assert.Equal($"\"{_target}\"", TextAt(text, range)));

    [Fact]
    public void ACopyInPluginSource_IsPlacedAtEachPlaceItsFileNamesTheRecord()
    {
        using var index = Indexes.Reconciled(_fixture);

        var placed = CopyOf(index.Queries.GetPlacedReferences(_target).Value(), _npc);

        Assert.Equal(index.Queries.GetCopyDocument(Compiled, _npc).Value(), placed.Document);
        Assert.Equal(2, placed.Ranges.Count);
        AssertEachRangeIsTheTarget(File.ReadAllText(placed.Document.Location), placed);
    }

    [Fact]
    public void AChildCopyInPluginSource_IsPlacedInItsContainersFile()
    {
        using var index = Indexes.Reconciled(_fixture);

        var placed = CopyOf(index.Queries.GetPlacedReferences(_target).Value(), _topic);

        Assert.Equal(new CopyDocument(CopyDocumentKind.ContainersFile, index.Queries.GetCopyDocument(Compiled, _topic).Value().Require().Location), placed.Document);
        Assert.Single(placed.Ranges);
        AssertEachRangeIsTheTarget(File.ReadAllText(placed.Document.Location), placed);
    }

    [Fact]
    public void ACopyWithNoPluginSource_IsPlacedInItsRenderedDocument()
    {
        using var index = Indexes.Reconciled(_fixture);

        var placed = CopyOf(index.Queries.GetPlacedReferences(_target).Value(), _renderedNpc);

        Assert.Equal(index.Queries.GetCopyDocument(Rendered, _renderedNpc).Value(), placed.Document);
        Assert.Single(placed.Ranges);
        AssertEachRangeIsTheTarget(index.Queries.GetRenderedDocument(Rendered, _renderedNpc).Value().Require().Text, placed);
    }

    [Fact]
    public void ACopyWhoseFileIsGone_IsLeftOutNamed()
    {
        using var index = Indexes.Reconciled(_fixture);
        File.Delete(index.Queries.GetCopyDocument(Compiled, _npc).Value().Require().Location);

        var placed = index.Queries.GetPlacedReferences(_target).Value();

        Assert.DoesNotContain(placed.Copies, copy => copy.FormKey == _npc);
        Assert.StartsWith($"{_npc} in {Compiled.Name} ({Compiled.Origin}): ", Assert.Single(placed.LeftOut), StringComparison.Ordinal);
    }

    private static string LeftOut(PlacedReferences placed, string formKey, PluginAddress plugin) =>
        Assert.Single(placed.LeftOut, why => why.StartsWith($"{formKey} in {plugin.Name} ({plugin.Origin}): ", StringComparison.Ordinal));

    [Fact]
    public void ACopyInPluginSource_IsPlacedInItsUnsavedText()
    {
        using var index = Indexes.Reconciled(_fixture);
        var file = index.Queries.GetCopyDocument(Compiled, _npc).Value().Require().Location;
        var onDisk = CopyOf(index.Queries.GetPlacedReferences(_target).Value(), _npc).Ranges.Select(range => range.Start.Line);
        var unsaved = "\n\n" + File.ReadAllText(file);
        index.Unsaved.Apply([new DocumentChange(file, unsaved)]);

        var placed = CopyOf(index.Queries.GetPlacedReferences(_target).Value(), _npc);

        AssertEachRangeIsTheTarget(unsaved, placed);
        Assert.Equal(onDisk.Select(line => line + 2), placed.Ranges.Select(range => range.Start.Line));
    }

    [Theory]
    [InlineData("\r\n")]
    [InlineData("\r")]
    public void ACopyInPluginSource_IsPlacedOnTheLinesVSCodeShows_WhateverEndsThem(string lineEnd)
    {
        using var index = Indexes.Reconciled(_fixture);
        var file = index.Queries.GetCopyDocument(Compiled, _npc).Value().Require().Location;
        var text = VSCodeLineEnd.Replace(File.ReadAllText(file), lineEnd);
        index.Unsaved.Apply([new DocumentChange(file, text)]);

        var placed = CopyOf(index.Queries.GetPlacedReferences(_target).Value(), _npc);

        Assert.Equal(2, placed.Ranges.Count);
        AssertEachRangeIsTheTarget(text, placed);
    }

    [Fact]
    public void ACopyInPluginSourceWhoseTextNamesTheRecordNowhere_IsLeftOutNamed()
    {
        using var index = Indexes.Reconciled(_fixture);
        var file = index.Queries.GetCopyDocument(Compiled, _npc).Value().Require().Location;
        File.WriteAllText(file, File.ReadAllText(file).Replace(_target, _topic, StringComparison.Ordinal));

        var placed = index.Queries.GetPlacedReferences(_target).Value();

        Assert.DoesNotContain(placed.Copies, copy => copy.FormKey == _npc);
        Assert.EndsWith($"names {_target} nowhere.", LeftOut(placed, _npc, Compiled), StringComparison.Ordinal);
    }

    [Fact]
    public void ACopyInPluginSourceThatTwoFilesClaim_IsLeftOutNamingThem()
    {
        using var index = Indexes.Reconciled(_fixture);
        var file = index.Queries.GetCopyDocument(Compiled, _npc).Value().Require().Location;
        var backup = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(file).Require(), "Backup")).FullName;
        File.Copy(file, Path.Combine(backup, Path.GetFileName(file)));

        var placed = index.Queries.GetPlacedReferences(_target).Value();

        Assert.DoesNotContain(placed.Copies, copy => copy.FormKey == _npc);
        Assert.Contains("Backup", LeftOut(placed, _npc, Compiled), StringComparison.Ordinal);
    }

    [Fact]
    public void ACopyWhoseRenderedDocumentNamesTheRecordNowhere_IsPlacedAtItsOwnFormKey()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);
        IndexFiles.Execute(_fixture.InstanceRoot, $"UPDATE mirror.records SET body = replace(body, '{_target}', '{_npc}') WHERE form_key = '{_renderedNpc}'");

        var placed = CopyOf(index.Queries.GetPlacedReferences(_target).Value(), _renderedNpc);

        var text = index.Queries.GetRenderedDocument(Rendered, _renderedNpc).Value().Require().Text;
        Assert.Equal($"\"{_renderedNpc}\"", TextAt(text, Assert.Single(placed.Ranges)));
    }

    [Fact]
    public void ACopyWhoseRenderedDocumentStatesNoCopy_IsLeftOutNamed()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);
        IndexFiles.Execute(_fixture.InstanceRoot, $"UPDATE mirror.records SET body = '{{}}' WHERE form_key = '{_renderedNpc}'");

        var placed = index.Queries.GetPlacedReferences(_target).Value();

        Assert.DoesNotContain(placed.Copies, copy => copy.FormKey == _renderedNpc);
        Assert.EndsWith($"states no {_renderedNpc}.", LeftOut(placed, _renderedNpc, Rendered), StringComparison.Ordinal);
    }

    [Fact]
    public void AReferrerItsPluginHoldsNoCopyOf_IsLeftOutNamed()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);
        IndexFiles.Execute(_fixture.InstanceRoot, $"DELETE FROM mirror.records WHERE form_key = '{_renderedNpc}'");

        var placed = index.Queries.GetPlacedReferences(_target).Value();

        Assert.DoesNotContain(placed.Copies, copy => copy.FormKey == _renderedNpc);
        Assert.EndsWith($"{Rendered.Name} holds no copy of it.", LeftOut(placed, _renderedNpc, Rendered), StringComparison.Ordinal);
    }
}
