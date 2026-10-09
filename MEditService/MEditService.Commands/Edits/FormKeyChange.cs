using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>An edit of a record's FormID changes its FormKey, and moves the Next Object ID past it. The records
/// that reference it, itself included, are left as they are, and updating them is a script.</summary>
internal sealed class FormKeyChange(ILogger logger)
{
    /// <summary>The document member a record's FormID is, which the edit's path names.</summary>
    internal const string Member = RecordMembers.FormKey;

    /// <summary>Whether the envelope sets the record's FormID rather than a field of its document.</summary>
    internal static bool IsFormIdEdit(RecordEditEnvelope envelope) =>
        envelope is { Op: RecordEditEnvelope.Set, Path: [{ Kind: PathHop.MemberKind, Name: Member }] };

    /// <summary>The record's file or folder moved to its new key.</summary>
    internal SourceAnswer<RecordEditResult> Change(
        PluginAddress plugin, string formKey, WriteTargets.EditTarget editTarget, JsonElement? value)
    {
        var (release, identity, repository) = editTarget;
        if (identity.RecordType == PluginHeader.RecordType)
        {
            return RecordTextEdit.ReadOnlyRefusal(Member, Member, PluginHeader.FormIdReadOnly);
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

        if (!FormKeyAllocator.Over(repository, plugin, release).Holds(out var allocator, out var unread)) return unread;
        if (allocator.Claim(requestedFormKey, out var targetFormKey) is { } refusedTarget) return refusedTarget with { Path = Member };

        var failed = $"Changing the FormID of {formKey} to {targetFormKey} failed";
        return WriteFailure.Refused(
            RecordEditResult.Making(RecordEditResult.Success(targetFormKey), repository, transaction =>
            {
                transaction.Apply(repository.ChangesToRekey(plugin, identity, targetFormKey));
                transaction.Apply(allocator.HeaderChanges());
            }),
            refused => refused, failed, logger);
    }
}
