using System.Diagnostics;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>An edit of a record's FormID changes its FormKey and nothing else: the records that
/// reference it, itself included, are left as they are, and updating them is a script.</summary>
internal sealed class FormKeyChange(
    WriteTargets targets, RecordTextCodec codec, ILogger logger)
{
    /// <summary>The document member a record's FormID is, which the edit's path names.</summary>
    internal const string Member = RecordMembers.FormKey;

    /// <summary>Whether the envelope sets the record's FormID rather than a field of its document.</summary>
    internal static bool IsFormIdEdit(RecordEditEnvelope envelope) =>
        envelope is { Op: RecordEditEnvelope.Set, Path: [{ Kind: PathHop.MemberKind, Name: Member }] };

    /// <summary>A delete+create pair in source terms, written through a
    /// <see cref="SourceRepository.SourceTransaction"/> that restores the tree on failure.</summary>
    internal RecordEditResult Change(
        PluginAddress plugin, string formKey, WriteTargets.EditTarget editTarget, SourceDocument carrying, JsonElement? value)
    {
        var (release, identity, repository) = editTarget;
        if (identity.RecordType == PluginHeader.RecordType)
        {
            return DocumentEdit.ReadOnlyRefusal(Member, Member, PluginHeader.FormIdReadOnly);
        }

        if (value is not { ValueKind: JsonValueKind.String } text
            || !FormKey.TryFactory(text.GetString(), out var requested))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.CodecRejected, Member,
                $"{(value is { } given ? given.GetRawText() : "Nothing")} is not a FormKey. A FormID is written " +
                $"as its FormKey, the local ID in hex and then the plugin it is native to: 000800:{plugin.Name}.");
        }

        var parsedFormKey = FormKey.Factory(formKey);
        formKey = parsedFormKey.ToString();
        var requestedFormKey = requested.ToString();
        if (requestedFormKey == formKey) return RecordEditResult.Success();

        var originatingPlugin = parsedFormKey.ModKey.FileName.String;
        if (!originatingPlugin.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.NotNativeRecord, Member,
                $"{formKey} is an override in {plugin.Name}: {originatingPlugin} is its master. " +
                $"Change its FormID in {originatingPlugin}, where the record is native.");
        }

        if (targets.ResolveTargetFormKey(repository, plugin, requestedFormKey, out var targetFormKey)
            is { } refusedTarget) return refusedTarget with { Path = Member };

        var transaction = new SourceRepository.SourceTransaction();
        if (SourceCommit.Write(transaction, repository, logger, $"Changing the FormID of {formKey} to {targetFormKey} failed.", () =>
            {
                if (ComputeTargetRewrite(plugin, repository, identity, carrying, formKey, targetFormKey, release, out var targetRewrite)
                    is { } refusedSelf) return refusedSelf;
                WriteTargetRewrite(
                    transaction, repository, plugin,
                    targetRewrite ?? throw new UnreachableException("ComputeTargetRewrite neither refused nor computed a target."),
                    targetFormKey);
                return null;
            }) is { } refused) return refused;

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Changed the FormID of {OldFormKey} to {NewFormKey} in {Plugin} ({Origin})",
                formKey, targetFormKey, plugin.Name, plugin.Origin);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // Text is the target's own document under its new FormKey — the owner's whole text when
    // embedded — and Written is that document's identity. Held is the target's own identity, as the
    // tree has it.
    private sealed record ComputedTarget(RecordIdentity Written, RecordIdentity Held, string Text);

    // Nothing here writes; every failure mode is a typed refusal. The carrying document is the
    // record's own, or the owner's when another record's document carries it.
    private RecordEditResult? ComputeTargetRewrite(
        PluginAddress plugin, SourceRepository repository, RecordIdentity identity, SourceDocument carrying,
        string oldFormKey, string newFormKey, GameRelease release, out ComputedTarget? target)
    {
        target = null;

        if (!carrying.FormKey.Equals(identity.FormKey, StringComparison.Ordinal))
        {
            if (RecordDocumentEdits.WithEmbeddedChildFormKey(
                    codec, carrying.Body, release, carrying.RecordType, oldFormKey, newFormKey)
                is not { } ownerText)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"{repository.RelativePathOf(plugin, identity)} was found holding {oldFormKey}, but its own text does not carry it. " +
                    "Nothing was written.");
            }

            target = new ComputedTarget(carrying.Identity, identity, ownerText);
            return null;
        }

        target = new ComputedTarget(
            new RecordIdentity(newFormKey, identity.RecordType, identity.EditorId), identity,
            RecordDocumentEdits.WithFormKey(codec, carrying.Body, release, carrying.RecordType, newFormKey));
        return null;
    }

    // The container moves whole, its block subtree with it, and the put that follows finds and
    // replaces it; a flat record's put lands at the leaf the new FormKey computes, and the remove
    // takes the file the old FormKey named. An embedded record has no leaf of its own, so the owner's
    // reserialized document is the whole write, and nothing is left for the remove to find.
    private static void WriteTargetRewrite(
        SourceRepository.SourceTransaction transaction, SourceRepository repository, PluginAddress plugin,
        ComputedTarget target, string newFormKey)
    {
        var (written, held, text) = target;
        transaction.Move(repository, plugin, held, newFormKey);
        transaction.Put(repository, plugin, new SourceDocument(written.FormKey, written.RecordType, written.EditorId, text));

        if (transaction.Remove(repository, plugin, held) == SourceRemoval.OwnerDoesNotCarryIt)
            throw new IOException($"The document holding {held.FormKey} does not carry it, so the FormID change cannot take it out.");
    }
}
