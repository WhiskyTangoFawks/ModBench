using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>An edit of a record's FormID changes its FormKey, and moves the Next Object ID past it. Every plugin source
/// naming it follows (ADR-0028).</summary>
internal sealed class FormKeyChange(ILogger logger)
{
    /// <summary>Each plugin source of the load order, the record's own included, naming <paramref name="newFormKey"/>
    /// where it named <paramref name="formKey"/>, in <paramref name="sessions"/>. Answers each it left as it was, and why.</summary>
    internal static IReadOnlyList<SourceLeftBehind> Follow(
        ISourceAdapter source, LoadOrderSnapshot loadOrder, string formKey, string newFormKey, WriteSessions sessions)
    {
        var (reading, leftBehind) = PluginSources.Of(source, loadOrder);
        foreach (var (plugin, mod) in reading)
        {
            var session = sessions.Over(mod, loadOrder.GameRelease);
            if (session.Atomically(() => session.Apply(session.Repository.ChangesToFollowFormKeyChange(plugin.Key, formKey, newFormKey))) is { } failure)
                leftBehind.Add(new(plugin.Key, failure.Reason));
        }
        return leftBehind;
    }

    /// <summary>The document member a record's FormID is, which the edit's path names.</summary>
    internal const string Member = RecordMembers.FormKey;

    /// <summary>Whether the envelope sets the record's FormID rather than a field of its document.</summary>
    internal static bool IsFormIdEdit(RecordEditEnvelope envelope) =>
        envelope is { Op: RecordEditEnvelope.Set, Path: [{ Kind: PathHop.MemberKind, Name: Member }] };

    /// <summary>The record under its new key.</summary>
    internal Answer<RecordEditResult, SourceFailure> Change(
        PluginAddress plugin, string formKey, WriteTargets.EditTarget editTarget, EditValue? value)
    {
        var (release, identity, session) = editTarget;
        var repository = editTarget.Repository;
        if (identity.RecordType == PluginHeader.RecordType)
        {
            return RecordTextEdit.ReadOnlyRefusal(Member, Member, PluginHeader.FormIdReadOnly);
        }

        if (value is not { Kind: EditValueKind.Text } text
            || !FormKey.TryFactory(text.Text, out var requested))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.CodecRejected, Member,
                $"{(value is { } given ? given.RawText : "Nothing")} is not a FormKey. A FormID is written " +
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
            RecordEditResult.Making(RecordEditResult.Success(targetFormKey), session, () =>
            {
                session.Apply(repository.ChangesToRekey(plugin, identity, targetFormKey));
                session.Apply(allocator.HeaderChanges());
            }),
            refused => refused, failed, logger);
    }
}
