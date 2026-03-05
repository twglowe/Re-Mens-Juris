    if (req.method === "POST") {
      const { matter_id, question, answer, tool_name } = req.body;
      const access = await canAccess(user.id, matter_id);
      if (!access) return res.status(403).json({ error: "Access denied" });
      const { error } = await supabase.from("conversation_history").insert({
        matter_id, user_id: user.id, question, answer, tool_name: tool_name || null
      });
      if (error) throw error;
      return res.status(201).json({ success: true });
    }

    // DELETE — clear history for a matter
    if (req.method === "DELETE") {
      const { matter_id } = req.query;
      const { error } = await supabase.from("conversation_history")
        .delete().eq("matter_id", matter_id).eq("user_id", user.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
